import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const __aiFilename = fileURLToPath(import.meta.url);
const __aiDirname = path.dirname(__aiFilename);
const REFERENCE_PHOTOS_DIR = path.join(__aiDirname, '..', 'config', 'reference_photos');

export interface AiVerdict {
  verdict: 'ok' | 'fail';
  reason: string;
  confidence: number;
}

const AI_TIMEOUT_MS = 60_000;

const rulePrompts: Record<string, string> = {
  uniform_check: [
    'Ты — эксперт по контролю дресс-кода на предприятии.',
    'Проверь фото: сотрудник одет в рабочую униформу?',
    'Униформа — это фирменная одежда (фартук, поло с логотипом, спецодежда).',
    'Домашняя или уличная одежда без элементов формы — это FAIL.',
  ].join(' '),

  steam_check: [
    'Ты — эксперт по проверке работоспособности кофемашин.',
    'Проверь фото: кофемашина включена и работает?',
    'Признаки работы: пар, светящийся индикатор, дисплей включён, процесс приготовления.',
    'Выключенная машина, чёрный экран, отсутствие признаков работы — это FAIL.',
  ].join(' '),

  cleanliness_check: [
    'Ты — эксперт по контролю чистоты и порядка на рабочем месте.',
    'Проверь фото: на рабочем месте в целом чисто и порядок?',
    'Будь лояльным: мелкие недочёты (пыль, незначительные следы, небольшой беспорядок) — это OK.',
    'FAIL ставь ТОЛЬКО при явных серьёзных нарушениях: много мусора на полу, грязная посуда на столах, разлитые жидкости, сильный беспорядок.',
    'Если сомневаешься — ставь OK.',
  ].join(' '),

  temperature_check: [
    'Ты — эксперт по контролю температурного режима на кухне.',
    'Проверь фото: видна температура на термометре/дисплее холодильника?',
    'Допустимые диапазоны: холодильник от 0 до +6°C, морозильник от -18 до -25°C.',
    'OK если температура видна и в допустимом диапазоне.',
    'FAIL если: температура не видна, показания вне нормы, фото не содержит термометра.',
    'Если сомневаешься — ставь OK.',
  ].join(' '),

  photo_relevance: [
    'Ты — эксперт по проверке фотографий для рабочего чек-листа.',
    'Проверь: фото соответствует заданию из чек-листа?',
    'FAIL если: фото пустое, чёрное, размытое до неузнаваемости, скриншот, фото экрана, случайное фото не по теме, фото из интернета.',
    'OK если: на фото виден объект, описанный в задании, даже если качество среднее.',
    'Будь лояльным: если фото хотя бы примерно соответствует заданию — ставь OK.',
    'Если сомневаешься — ставь OK.',
  ].join(' '),
};

// Отклоняем только при fail с уверенностью >= порога; иначе принимаем фото.
const MIN_CONFIDENCE = config.AI_FAIL_MIN_CONFIDENCE;

const SYSTEM_PROMPT = [
  'Ты проверяешь фотографии сотрудников для чек-листа.',
  `FAIL ставь только если АБСОЛЮТНО уверен (confidence >= ${MIN_CONFIDENCE}).`,
  'Если есть сомнения — ставь OK. Лучше пропустить чем ошибочно отклонить.',
  'Отвечай СТРОГО в формате JSON без markdown:',
  '{"verdict":"ok","reason":"...","confidence":0.95}',
  'verdict — только "ok" или "fail".',
  'reason — краткое объяснение ИСКЛЮЧИТЕЛЬНО на русском языке кириллицей (1-2 предложения).',
  'ЗАПРЕЩЕНО использовать в reason любые буквы кроме кириллицы и латиницы (и обычной пунктуации).',
  'НЕ используй арабский, фарси, китайский, тайский, иврит и другие письменности.',
  'Если не знаешь русское слово — используй простое описательное выражение.',
  'confidence — число от 0.0 до 1.0, твоя уверенность в ответе.',
  'Не добавляй ничего кроме JSON.',
].join(' ');

const REFERENCE_SYSTEM_PROMPT = [
  'Ты проверяешь фотографии сотрудников для чек-листа.',
  'Тебе даны два изображения: первое — эталон (как должно выглядеть), второе — фото сотрудника.',
  '',
  'КРИТЕРИИ СРАВНЕНИЯ:',
  '- Тип объекта: на фото сотрудника тот же тип объекта/помещения/предмета что на эталоне.',
  '- Состояние: объект в приемлемом состоянии (чисто, аккуратно, на месте).',
  '- НЕ сравнивай: лица, фон, освещение, ракурс, точное расположение предметов.',
  '- Фото может быть снято с другого угла — это нормально.',
  '',
  'ПРАВИЛА ВЕРДИКТА:',
  '- FAIL только если ты АБСОЛЮТНО уверен что фото не соответствует.',
  '- Если есть хоть малейшее сомнение — ставь OK.',
  '- Лучше пропустить сомнительное фото, чем ошибочно отклонить.',
  '',
  'Отвечай СТРОГО в формате JSON без markdown:',
  '{"verdict":"ok","reason":"...","confidence":0.95}',
  'verdict — только "ok" или "fail".',
  'reason — краткое объяснение ИСКЛЮЧИТЕЛЬНО на русском языке кириллицей (1-2 предложения).',
  'ЗАПРЕЩЕНО использовать в reason любые буквы кроме кириллицы и латиницы (и обычной пунктуации).',
  'НЕ используй арабский, фарси, китайский, тайский, иврит и другие письменности.',
  'Если не знаешь русское слово — используй простое описательное выражение.',
  'confidence — число от 0.0 до 1.0, твоя уверенность в ответе.',
  'Не добавляй ничего кроме JSON.',
].join(' ');

const referenceHints: Record<string, string> = {
  uniform_check: 'Первое фото — ЭТАЛОН рабочей униформы данного заведения. Считай что одежда на эталоне — это и есть правильная униформа, даже если она выглядит как обычная одежда. Твоя задача: проверить что на втором фото сотрудник одет в ПОХОЖУЮ одежду. Цвет, фасон, бейджик и мелкие детали могут отличаться. Не сравнивай лицо, причёску, фон. Если одежда хотя бы примерно похожа на эталон — ставь OK.',
  cleanliness_check: 'Проверь что помещение/зона в похожем чистом состоянии как на эталоне. Допустимы мелкие отличия в расстановке предметов.',
  photo_relevance: 'Проверь что на фото тот же тип объекта/зоны что на эталоне.',
};

// A predefined key (uniform_check, photo_relevance, etc.) is short and snake_case.
// Free-form descriptions from the checklists table contain spaces/sentences.
function isPredefinedKey(aiRule: string): boolean {
  return /^[a-z_]+$/i.test(aiRule.trim()) && aiRule.length < 40;
}

/** Пункт (B) и подробное описание (G) из Google-таблицы, склеенные через \\n\\n */
export function splitQuestionText(text: string): { title: string; description: string | null } {
  const idx = text.indexOf('\n\n');
  if (idx === -1) return { title: text.trim(), description: null };
  const title = text.slice(0, idx).trim();
  const description = text.slice(idx + 2).trim();
  return { title, description: description.length > 0 ? description : null };
}

export function shouldRunPhotoAi(taskType: string | null | undefined): boolean {
  return taskType === 'photo' || taskType === 'confirm_photo';
}

/**
 * Строгое правило из конфига (uniform_check, текст из таблицы) или
 * критерий из текста пункта чек-листа, если ai_rule не задан.
 */
export function resolvePhotoCheckRule(
  aiRule: string | null | undefined,
  questionText: string,
): string {
  const trimmedRule = aiRule?.trim();
  if (trimmedRule) return trimmedRule;

  const { title, description } = splitQuestionText(questionText);
  const lines = [
    'Проверь, что фото подтверждает выполнение пункта чек-листа.',
    `Пункт: ${title}`,
  ];
  if (description) {
    lines.push(`Требования и критерии из чек-листа: ${description}`);
  }
  lines.push(
    'OK если на фото видно, что пункт в целом выполнен (нужная зона, объект или действие).',
    'FAIL только при явном несоответствии, пустом/не по теме снимке.',
    'Если сомневаешься — OK.',
  );
  return lines.join('\n');
}

function buildReferencePrompt(aiRule: string, questionText: string): string {
  if (isPredefinedKey(aiRule)) {
    const hint = referenceHints[aiRule] ?? 'Проверь что фото сотрудника соответствует эталону по содержанию.';
    return `${hint}\n\nВопрос из чек-листа: "${questionText}"`;
  }
  // Free-form description from the checklists table — use as the criteria
  return [
    'Сравни фото сотрудника с эталоном по следующему критерию:',
    aiRule,
    '',
    `Вопрос из чек-листа: "${questionText}"`,
  ].join('\n');
}

function buildUserPrompt(aiRule: string, questionText: string): string {
  if (isPredefinedKey(aiRule)) {
    const rulePrompt = rulePrompts[aiRule];
    if (rulePrompt) {
      return `${rulePrompt}\n\nВопрос из чек-листа: "${questionText}"`;
    }
  }
  // Free-form description — use as the criteria directly
  return [
    'Проверь фото по следующему критерию:',
    aiRule,
    '',
    `Вопрос из чек-листа: "${questionText}"`,
  ].join('\n');
}

// Strip writing systems the model sometimes hallucinates (Arabic, Hebrew, CJK,
// Devanagari, Thai, Korean, Japanese, etc.). Cyrillic/Latin/punctuation/emoji stay.
function sanitizeRussianReason(text: string): string {
  const cleaned = text.replace(
    /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ऀ-ॿঀ-৿਀-੿઀-૿଀-୿஀-௿ఀ-౿ಀ-೿ഀ-ൿ฀-๿຀-໿က-႟぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯ﭐ-﷿ﹰ-﻿]/g,
    '',
  );
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

function parseAiResponse(content: string): AiVerdict {
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const verdict = parsed['verdict'] === 'fail' ? 'fail' : 'ok';
  const rawReason = typeof parsed['reason'] === 'string' ? parsed['reason'] : 'Нет описания';
  const reason = sanitizeRussianReason(rawReason) || 'Нет описания';
  let confidence = typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return { verdict, reason, confidence };
}

function mimeTypeForReferenceFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function loadReferencePhoto(filename: string): Promise<string | null> {
  try {
    const filePath = path.join(REFERENCE_PHOTOS_DIR, filename);
    console.log('[ai] Loading reference photo from:', filePath);
    const buffer = await readFile(filePath);
    console.log('[ai] Reference photo loaded OK, size:', buffer.length);
    return buffer.toString('base64');
  } catch (err) {
    console.warn(`[aiService] Reference photo not found: ${filename}`, err);
    return null;
  }
}

export async function verifyPhoto(
  imageBuffer: Buffer,
  aiRule: string,
  questionText: string,
  referencePhoto?: string | null,
): Promise<AiVerdict> {
  if (!config.OPENAI_API_KEY) {
    return { verdict: 'ok', reason: 'AI не настроен, фото принято', confidence: 0 };
  }

  try {
    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    let refFilename: string | null = null;
    if (typeof referencePhoto === 'string') {
      // Может быть JSON-массив, сериализованный в строку
      if (referencePhoto.startsWith('[')) {
        try {
          const arr = JSON.parse(referencePhoto) as string[];
          if (arr.length > 0) {
            refFilename = arr[Math.floor(Math.random() * arr.length)];
          }
        } catch {
          refFilename = referencePhoto;
        }
      } else {
        refFilename = referencePhoto;
      }
    }

    console.log('[ai] referencePhoto:', referencePhoto, '| refFilename:', refFilename);

    const refBase64 = refFilename ? await loadReferencePhoto(refFilename) : null;
    console.log('[ai] refBase64 loaded:', refBase64 ? `yes (${refBase64.length} chars)` : 'NO');

    let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];

    if (refBase64 && refFilename) {
      const refMime = mimeTypeForReferenceFile(refFilename);
      const refDataUrl = `data:${refMime};base64,${refBase64}`;
      messages = [
        { role: 'system', content: REFERENCE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildReferencePrompt(aiRule, questionText) },
            { type: 'image_url', image_url: { url: refDataUrl, detail: 'low' } },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ];
    } else {
      messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserPrompt(aiRule, questionText) },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ];
    }

    const response = await Promise.race([
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT_MS),
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { verdict: 'ok', reason: 'AI вернул пустой ответ, фото принято', confidence: 0 };
    }

    const result = parseAiResponse(content);
    console.log('[ai] result:', JSON.stringify(result));

    // Порог уверенности: если AI не уверен на 90%+ — не наказываем сотрудника
    if (result.verdict === 'fail' && result.confidence < MIN_CONFIDENCE) {
      return {
        verdict: 'ok',
        reason: `AI не уверен (${Math.round(result.confidence * 100)}%), фото принято`,
        confidence: result.confidence,
      };
    }

    return result;
  } catch (error) {
    console.error('[aiService] error:', error);
    return { verdict: 'ok', reason: 'AI недоступен, фото принято', confidence: 0 };
  }
}
