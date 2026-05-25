import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { prisma } from '../db/client.js';
import { config } from '../config/index.js';
import type { LanguageCode } from '../config/roles.js';

const TRANSLATION_TIMEOUT_MS = 15_000;

const languageNames: Record<LanguageCode, string> = {
  ru: 'Russian',
  en: 'English',
  hi: 'Hindi',
  fa: 'Farsi (Persian)',
  uz: 'Uzbek (Latin script, modern Uzbekistan orthography)',
  tg: 'Tajik (Cyrillic script)',
  ky: 'Kyrgyz (Cyrillic script)',
  ur: 'Urdu (Arabic/Nasta\'liq script)',
};

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

let openaiClient: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!config.OPENAI_API_KEY) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return openaiClient;
}

async function callTranslator(
  text: string,
  sourceLang: LanguageCode,
  targetLang: LanguageCode,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const sourceName = languageNames[sourceLang];
  const targetName = languageNames[targetLang];

  try {
    const response = await client.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: [
              `You are a professional translator for a restaurant checklist bot.`,
              `Translate from ${sourceName} to ${targetName}.`,
              `Return ONLY the translation, no explanations, no quotes.`,
              `Keep emojis, numbers, punctuation. Preserve any technical/role terms naturally.`,
            ].join(' '),
          },
          { role: 'user', content: text },
        ],
      },
      { timeout: TRANSLATION_TIMEOUT_MS },
    );

    const translated = response.choices[0]?.message?.content?.trim();
    return translated && translated.length > 0 ? translated : null;
  } catch (error) {
    console.error('[translation error]', error);
    return null;
  }
}

/**
 * Hybrid translation: returns text as-is if source equals target,
 * otherwise checks DB cache, then falls back to AI translation
 * (and caches the result). On any error returns the original text.
 */
export async function translate(
  text: string,
  targetLang: LanguageCode,
  sourceLang: LanguageCode = 'ru',
): Promise<string> {
  if (!text || text.trim().length === 0) return text;
  if (sourceLang === targetLang) return text;

  const sourceHash = hashText(text);

  const cached = await prisma.translation.findUnique({
    where: {
      sourceLang_targetLang_sourceHash: {
        sourceLang,
        targetLang,
        sourceHash,
      },
    },
  });

  if (cached) return cached.targetText;

  const translated = await callTranslator(text, sourceLang, targetLang);
  if (!translated) return text;

  try {
    await prisma.translation.create({
      data: {
        sourceLang,
        targetLang,
        sourceHash,
        sourceText: text,
        targetText: translated,
      },
    });
  } catch {
    // Race condition on unique key — ignore, value already cached
  }

  return translated;
}
