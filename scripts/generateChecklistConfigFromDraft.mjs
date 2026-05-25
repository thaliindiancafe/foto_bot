import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_DIR = path.resolve('outputs', 'serviceinspector', 'march-2026-mapped');
const CURRENT_CONFIG_PATH = path.resolve('src', 'config', 'checklists.json');
const DRAFT_PATH = path.join(OUTPUT_DIR, 'checklists.bot-draft.json');
const INSPECTOR_PATH = path.join(OUTPUT_DIR, 'inspector-nomenclature.json');
const COMMON_PATH = path.join(OUTPUT_DIR, 'common-nomenclature.json');

const DEFAULT_ALL_DAY_WINDOWS = [{ start: '06:00', end: '01:00' }];
const DEFAULT_PERIODIC_WINDOWS = [
  { start: '10:00', end: '10:15' },
  { start: '12:00', end: '12:15' },
  { start: '14:00', end: '14:15' },
  { start: '16:00', end: '16:15' },
  { start: '18:00', end: '18:15' },
  { start: '20:00', end: '20:15' },
];

const ROLE_LABEL_TO_KEY = new Map([
  ['Менеджер', 'manager'],
  ['Управляющий', 'manager'],
  ['Официант', 'waiter'],
  ['Клинер', 'cleaner'],
  ['Повар', 'cook'],
  ['Помощник повара', 'helper'],
  ['Су-шеф', 'sous_chef'],
  ['Шеф повар', 'chef'],
  ['Бармен', 'barista'],
]);

const ROLE_ORDER = new Map([
  ['manager', 0],
  ['waiter', 1],
  ['cleaner', 2],
  ['cook', 3],
  ['helper', 4],
  ['sous_chef', 5],
  ['chef', 6],
  ['barista', 7],
]);

const TYPE_ORDER = new Map([
  ['open', 0],
  ['periodic', 1],
  ['manual', 2],
  ['close', 3],
  ['handover_open', 4],
  ['handover_close', 5],
]);

const ROLE_NAMES = {
  manager: 'Менеджер',
  waiter: 'Официант',
  cleaner: 'Клинер',
  cook: 'Повар',
  helper: 'Хелпер',
  sous_chef: 'Су-шеф',
  chef: 'Шеф',
  barista: 'Бариста',
};

const AUDIT_OVERRIDES = {
  '9b667be5-867b-4e51-9d70-f5cffc85d9d0': {
    type: 'periodic',
    time_windows: DEFAULT_PERIODIC_WINDOWS,
  },
  '1009fbb5-f34a-4181-ae03-16a53ba71b39': {
    type: 'manual',
  },
  'f6e70ae6-1145-4a33-b92d-9798840af2da': {
    type: 'manual',
  },
  'fd653652-cadd-43f5-9ecd-733820b7a9d0': {
    type: 'open',
    time_windows: DEFAULT_ALL_DAY_WINDOWS,
  },
};

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTaskFallbackMap(checklist) {
  const fallback = new Map();

  for (const task of checklist.tasks ?? []) {
    const key = normalizeText(task.text);
    if (!key || fallback.has(key)) {
      continue;
    }

    fallback.set(key, {
      ai_rule: task.ai_rule ?? null,
      reference_photo: task.reference_photo ?? null,
      type: task.type ?? 'photo',
    });
  }

  return fallback;
}

function createChecklistId(auditId, roleKey) {
  return `si_${auditId.replace(/-/g, '')}_${roleKey}`;
}

function looksLikePhotoTask(value) {
  const haystack = normalizeText(value);
  return [
    'фото',
    'сфот',
    'селфи',
    'photo',
    'picture',
    'image',
    'selfie',
    'photograph',
  ].some((needle) => haystack.includes(needle));
}

function inferTaskType(taskName, fallback) {
  if (fallback?.type) {
    return fallback.type;
  }

  return looksLikePhotoTask(taskName) ? 'photo' : 'confirm';
}

function inferChecklistType(auditName, auditId) {
  if (AUDIT_OVERRIDES[auditId]?.type) {
    return AUDIT_OVERRIDES[auditId].type;
  }

  const normalized = normalizeText(auditName);

  if (
    normalized.includes('end of the day') ||
    normalized.includes('closing') ||
    normalized.includes('закрытие') ||
    normalized.includes('اختتام')
  ) {
    return 'close';
  }

  if (
    normalized.includes('start of the day') ||
    normalized.includes('opening') ||
    normalized.includes('открытие') ||
    normalized.includes('начало дня')
  ) {
    return 'open';
  }

  if (normalized.includes('big eight') || normalized.includes('8 for the cleaner')) {
    return 'periodic';
  }

  if (
    normalized.includes('журнал') ||
    normalized.includes('logbook') ||
    normalized.includes('general cleaning') ||
    normalized.includes('генеральн')
  ) {
    return 'manual';
  }

  return 'manual';
}

function getChecklistSchedule(auditId, checklistType) {
  const override = AUDIT_OVERRIDES[auditId];
  if (override?.time_windows) {
    return { time_windows: override.time_windows, interval_hours: undefined };
  }

  if (checklistType === 'periodic') {
    return { time_windows: DEFAULT_PERIODIC_WINDOWS, interval_hours: undefined };
  }

  if (checklistType === 'manual') {
    return { time_windows: undefined, interval_hours: undefined };
  }

  return { time_windows: DEFAULT_ALL_DAY_WINDOWS, interval_hours: undefined };
}

const [currentConfigRaw, draftConfigRaw, inspectorRaw, commonRaw] = await Promise.all([
  readFile(CURRENT_CONFIG_PATH, 'utf8'),
  readFile(DRAFT_PATH, 'utf8'),
  readFile(INSPECTOR_PATH, 'utf8'),
  readFile(COMMON_PATH, 'utf8'),
]);

const currentConfig = JSON.parse(currentConfigRaw);
const draftConfig = JSON.parse(draftConfigRaw);
const inspector = JSON.parse(inspectorRaw);
const common = JSON.parse(commonRaw);

const rolesById = new Map(
  (common.roles ?? [])
    .filter((role) => !role.deleted)
    .map((role) => [role.id, role.name]),
);

const draftByAuditId = new Map(
  (draftConfig.checklists ?? [])
    .filter((checklist) => typeof checklist.source_audit_id === 'string' && checklist.source_audit_id.length > 0)
    .map((checklist) => [checklist.source_audit_id, checklist]),
);

const currentChecklistsById = new Map(
  (currentConfig.checklists ?? []).map((checklist) => [checklist.id, checklist]),
);

const currentChecklistsByAuditId = new Map();
for (const checklist of currentConfig.checklists ?? []) {
  if (!checklist.source_audit_id || currentChecklistsByAuditId.has(checklist.source_audit_id)) {
    continue;
  }

  currentChecklistsByAuditId.set(checklist.source_audit_id, checklist);
}

const blocksByAuditId = new Map();
for (const block of inspector.checkLists ?? []) {
  if (block.deleted) {
    continue;
  }

  const list = blocksByAuditId.get(block.auditId) ?? [];
  list.push(block);
  blocksByAuditId.set(block.auditId, list);
}

const tasksByBlockId = new Map();
for (const task of inspector.tasks ?? []) {
  if (task.deleted) {
    continue;
  }

  const list = tasksByBlockId.get(task.checkListId) ?? [];
  list.push(task);
  tasksByBlockId.set(task.checkListId, list);
}

const generatedChecklists = [];

for (const audit of (inspector.audits ?? []).filter((item) => !item.deleted)) {
  const mappedRoles = [
    ...new Set(
      (audit.roles ?? [])
        .map((roleId) => rolesById.get(roleId))
        .map((roleLabel) => ROLE_LABEL_TO_KEY.get(roleLabel))
        .filter(Boolean),
    ),
  ];

  if (mappedRoles.length === 0) {
    continue;
  }

  const draftChecklist = draftByAuditId.get(audit.id);
  const fallbackChecklist =
    draftChecklist ??
    currentChecklistsByAuditId.get(audit.id) ??
    currentChecklistsById.get(audit.id) ??
    { tasks: [] };
  const fallbackByText = buildTaskFallbackMap(fallbackChecklist);
  const checklistType = draftChecklist?.type ?? inferChecklistType(audit.name, audit.id);
  const schedule = draftChecklist
    ? {
        time_windows: draftChecklist.time_windows,
        interval_hours: draftChecklist.interval_hours,
      }
    : getChecklistSchedule(audit.id, checklistType);

  const draftTasks = draftChecklist?.tasks ?? null;
  const generatedTasks = [];

  if (draftTasks && draftTasks.length > 0) {
    for (const [index, task] of draftTasks.entries()) {
      const fallback = fallbackByText.get(normalizeText(task.text));
      generatedTasks.push({
        order: index,
        text: task.text,
        type: task.type ?? fallback?.type ?? 'photo',
        section: task.section ?? null,
        ai_rule: task.ai_rule ?? fallback?.ai_rule ?? null,
        reference_photo: task.reference_photo ?? fallback?.reference_photo ?? null,
      });
    }
  } else {
    const blocks = (blocksByAuditId.get(audit.id) ?? []).sort((left, right) => left.order - right.order);
    let order = 0;

    for (const block of blocks) {
      const blockTasks = (tasksByBlockId.get(block.id) ?? []).sort((left, right) => left.order - right.order);

      for (const task of blockTasks) {
        const fallback = fallbackByText.get(normalizeText(task.name));
        generatedTasks.push({
          order,
          text: task.name,
          type: inferTaskType(task.name, fallback),
          section: block.name ?? null,
          ai_rule: fallback?.ai_rule ?? null,
          reference_photo: fallback?.reference_photo ?? null,
        });
        order += 1;
      }
    }
  }

  for (const roleKey of mappedRoles) {
    generatedChecklists.push({
      id: createChecklistId(audit.id, roleKey),
      role: roleKey,
      type: checklistType,
      name: draftChecklist?.name ?? audit.name,
      time_windows: schedule.time_windows,
      interval_hours: schedule.interval_hours,
      source_audit_id: audit.id,
      tasks: generatedTasks,
    });
  }
}

generatedChecklists.sort((left, right) => {
  const roleDiff = (ROLE_ORDER.get(left.role) ?? 999) - (ROLE_ORDER.get(right.role) ?? 999);
  if (roleDiff !== 0) {
    return roleDiff;
  }

  const typeDiff = (TYPE_ORDER.get(left.type) ?? 999) - (TYPE_ORDER.get(right.type) ?? 999);
  if (typeDiff !== 0) {
    return typeDiff;
  }

  return left.name.localeCompare(right.name, 'ru');
});

const nextConfig = {
  roles: Object.keys(ROLE_NAMES),
  roleNames: ROLE_NAMES,
  checklists: generatedChecklists,
};

await writeFile(CURRENT_CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      generatedChecklists: generatedChecklists.length,
      sourceAudits: new Set(generatedChecklists.map((checklist) => checklist.source_audit_id)).size,
      target: CURRENT_CONFIG_PATH,
    },
    null,
    2,
  ),
);
