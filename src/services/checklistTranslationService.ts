// Массовый AI-перевод чек-листов из src/config/checklists.json:
// каждый ru-чек-лист получает партнёра на каждом целевом языке. Логика
// идемпотентна — пропускает чек-листы, у которых уже есть партнёр.
//
// Используется:
// - из админ-кнопки «📥 Обновить из таблицы» (после синка из Google Sheets);
// - из CLI-скрипта scripts/translateChecklists.mjs (для ручного запуска).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { config } from '../config/index.js';
import type { LanguageCode } from '../config/roles.js';

const MODEL = 'gpt-4o-mini';

// Целевые языки batch-перевода чек-листов. Сейчас включены только те, что
// реально доступны для выбора сотрудниками (см. ACTIVE_LANG_CODES в roles.ts).
// uz / tg / ky / ur поддерживаются в коде — переводы UI, language names,
// translateOneChecklist — но в этом списке их нет, чтобы «Обновить из таблицы»
// не тратил OpenAI токены на языки, которые сотрудник пока не может выбрать.
// При активации нового языка: добавьте код сюда и в ACTIVE_LANG_CODES.
export const BATCH_TARGET_LANGS: ReadonlyArray<LanguageCode> = ['en', 'hi', 'fa'];

const LANGUAGE_PROMPT_NAMES: Record<LanguageCode, string> = {
  ru: 'Russian',
  en: 'natural, professional restaurant-service English',
  hi: 'natural, professional Hindi (Devanagari script) suitable for restaurant staff',
  fa: 'natural, professional Farsi/Persian (Arabic script) suitable for restaurant staff',
  uz: 'natural, professional Uzbek in modern Latin script suitable for restaurant staff',
  tg: 'natural, professional Tajik in Cyrillic script suitable for restaurant staff',
  ky: 'natural, professional Kyrgyz in Cyrillic script suitable for restaurant staff',
  ur: 'natural, professional Urdu (Arabic/Nastaʿlīq script) suitable for restaurant staff',
};

function buildSystemPrompt(targetLang: LanguageCode): string {
  const targetDescription = LANGUAGE_PROMPT_NAMES[targetLang];
  return `You are a professional translator for restaurant operation checklists.
Translate the user-provided JSON object from Russian to ${targetDescription}.

STRICT RULES:
- Preserve every emoji and Unicode prefix (🟥1️⃣, 🟧2️⃣, 🟩3️⃣, 🟦4️⃣, 🟪5️⃣, ℹ️, ✔, ✖, etc.) — copy them verbatim.
- Preserve all line breaks ("\\n", "\\n\\n") and list markers (1), 2), -, •).
- In task texts the structure is "<title>\\n\\n<description>" — keep that exact structure, with the same number of \\n\\n separators.
- Translate ai_rule strings the same way: clear, technical wording in the target language.
- Translate section names as short capitalized phrases in the target language.
- Keep the JSON shape and field names exactly. Do not add or remove fields.
- Return ONLY a single JSON object, no surrounding text.`;
}

type TaskInput = {
  order: number;
  text: string;
  type: string;
  section: string | null;
  ai_rule: string | null;
  reference_photo: string | null;
};

type ChecklistInput = {
  id: string;
  role: string;
  type: string;
  language: string;
  display_order?: number;
  name: string;
  time_windows?: { start: string; end: string }[];
  tasks: TaskInput[];
};

type TranslatedTaskPayload = {
  order: number;
  text: string;
  section: string | null;
  ai_rule: string | null;
};

type TranslatedChecklistPayload = {
  name: string;
  tasks: TranslatedTaskPayload[];
};

export type ChecklistTranslationResult = {
  translated: number;
  skipped: number;
  failed: number;
  newIds: string[];
};

function targetLangId(id: string, lang: LanguageCode): string {
  const suffix = `_${lang}`;
  if (id.endsWith('_ru')) return `${id.slice(0, -3)}${suffix}`;
  // Если id уже заканчивается на тот же язык — оставляем как есть.
  if (id.endsWith(suffix)) return id;
  // Если id заканчивается на другой языковой суффикс (_en, _hi и т.д.) —
  // заменяем (двухсимвольный код языка).
  if (/_(en|hi|fa|uz|tg|ky|ur)$/.test(id)) {
    return `${id.slice(0, -3)}${suffix}`;
  }
  return `${id}${suffix}`;
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!config.OPENAI_API_KEY) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return openaiClient;
}

async function translateOneChecklist(
  client: OpenAI,
  cl: ChecklistInput,
  targetLang: LanguageCode,
): Promise<ChecklistInput> {
  const payload = {
    name: cl.name,
    tasks: cl.tasks.map((t) => ({
      order: t.order,
      text: t.text,
      section: t.section ?? null,
      ai_rule: t.ai_rule ?? null,
    })),
  };

  const targetDescription = LANGUAGE_PROMPT_NAMES[targetLang];
  const completion = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSystemPrompt(targetLang) },
      {
        role: 'user',
        content: `Translate this checklist JSON to ${targetDescription}:\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('Empty completion from OpenAI');

  let parsed: TranslatedChecklistPayload;
  try {
    parsed = JSON.parse(content) as TranslatedChecklistPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI returned invalid JSON: ${message}`);
  }

  if (!parsed.name || !Array.isArray(parsed.tasks) || parsed.tasks.length !== cl.tasks.length) {
    throw new Error(
      `OpenAI response mismatch: name=${!!parsed.name}, tasks=${parsed.tasks?.length} (expected ${cl.tasks.length})`,
    );
  }

  const translatedTasks: TaskInput[] = cl.tasks.map((src, i) => {
    const tr = parsed.tasks.find((t) => t.order === src.order) ?? parsed.tasks[i];
    return {
      order: src.order,
      text: tr.text ?? src.text,
      type: src.type,
      section: tr.section ?? src.section,
      ai_rule: tr.ai_rule ?? src.ai_rule,
      reference_photo: src.reference_photo,
    };
  });

  return {
    id: targetLangId(cl.id, targetLang),
    role: cl.role,
    type: cl.type,
    language: targetLang,
    display_order: cl.display_order,
    name: parsed.name,
    time_windows: cl.time_windows,
    tasks: translatedTasks,
  };
}

/**
 * Идёт по src/config/checklists.json, для каждого ru-чек-листа создаёт
 * партнёра на `targetLang` через OpenAI (если ещё нет, либо если force=true).
 * Пишет результат обратно в JSON. Не делает db:seed — пусть вызывающий
 * сам синхронизирует БД.
 */
export async function translateMissingChecklistsToLanguage(
  targetLang: LanguageCode,
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<ChecklistTranslationResult> {
  const { force = false, log = () => {} } = opts;
  if (targetLang === 'ru') {
    log('[translate] target=ru — нечего переводить');
    return { translated: 0, skipped: 0, failed: 0, newIds: [] };
  }
  const client = getOpenAI();
  if (!client) {
    log('[translate] OPENAI_API_KEY не задан — пропускаю перевод');
    return { translated: 0, skipped: 0, failed: 0, newIds: [] };
  }

  const configPath = path.resolve('src/config/checklists.json');
  const json = JSON.parse(readFileSync(configPath, 'utf8'));
  const all: ChecklistInput[] = json.checklists ?? [];

  const existingIds = new Set(all.map((c) => c.id));
  const ruChecklists = all.filter((c) => c.language === 'ru' && c.role !== 'archived');

  log(
    `[translate:${targetLang}] candidates: ${ruChecklists.length} ru-checklist(s), force=${force}`,
  );

  let translated = 0;
  let skipped = 0;
  let failed = 0;
  const newChecklists: ChecklistInput[] = [];
  const newIds: string[] = [];

  for (const cl of ruChecklists) {
    const targetId = targetLangId(cl.id, targetLang);
    if (!force && existingIds.has(targetId)) {
      log(`[translate:${targetLang}] ⏭  skip ${cl.id} → ${targetId} (already exists)`);
      skipped++;
      continue;
    }

    try {
      log(`[translate:${targetLang}] 🔄 ${cl.id} → ${targetId} (${cl.tasks.length} tasks)…`);
      const tr = await translateOneChecklist(client, cl, targetLang);
      newChecklists.push(tr);
      newIds.push(tr.id);
      translated++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      log(`[translate:${targetLang}] ❌  ${cl.id}: ${message}`);
    }
  }

  if (newChecklists.length > 0) {
    if (force) {
      const newIdsSet = new Set(newChecklists.map((c) => c.id));
      json.checklists = all.filter((c) => !newIdsSet.has(c.id));
    } else {
      json.checklists = all;
    }
    json.checklists.push(...newChecklists);
    writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }

  log(
    `[translate:${targetLang}] done — translated=${translated}, skipped=${skipped}, failed=${failed}`,
  );
  return { translated, skipped, failed, newIds };
}

/**
 * Прогоняет batch-перевод для всех `BATCH_TARGET_LANGS`. Идемпотентно: для
 * каждой пары (chk, lang) пропускает уже существующий перевод.
 */
export async function translateMissingChecklistsToAllLanguages(
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<Record<LanguageCode, ChecklistTranslationResult>> {
  const result: Partial<Record<LanguageCode, ChecklistTranslationResult>> = {};
  for (const lang of BATCH_TARGET_LANGS) {
    result[lang] = await translateMissingChecklistsToLanguage(lang, opts);
  }
  return result as Record<LanguageCode, ChecklistTranslationResult>;
}

/**
 * Обратно совместимая обёртка: переводит только на английский. Сохранена,
 * чтобы старая админ-кнопка и CLI-скрипт продолжали работать.
 */
export async function translateMissingChecklistsToEnglish(
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<ChecklistTranslationResult> {
  return translateMissingChecklistsToLanguage('en', opts);
}
