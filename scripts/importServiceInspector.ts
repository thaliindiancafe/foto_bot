import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_BASE = process.env.SERVICE_INSPECTOR_API_BASE ?? 'https://server.serviceinspector.ru/api/0';
const DEFAULT_OUTPUT_ROOT = path.resolve('outputs', 'serviceinspector');
const DEFAULT_MATCH_THRESHOLD = 0.45;
const MANUAL_CHECKLIST_MAPPING: Record<string, string> = {
  '4d6b826a-59d4-44eb-8d43-8ddda653580e': 'barista_open',
  '9f9d398a-98bd-4bd8-8286-4affd62b4d31': 'barista_close',
  '6600696e-9d7b-444c-93d0-b681a5ff567c': 'cleaner_open',
  'faa7d0de-9c11-410a-96da-3dfb7a0b4823': 'cleaner_close',
  '317da9a1-e533-4492-b545-13c3a33919c2': 'cook_close',
  'a166ea32-8b57-4626-9074-f1684c983284': 'sous_chef_close',
  '5f837376-e8e0-4543-9ac1-2f0b6259acce': 'manager_periodic',
};

type JsonRecord = Record<string, unknown>;

type CurrentChecklistTask = {
  order: number;
  text: string;
  type?: 'photo' | 'confirm';
  section?: string;
  weight?: number;
  can_skip?: boolean;
  create_violation_on_no?: boolean;
  ai_rule?: string | null;
  reference_photo?: string | string[] | null;
};

type CurrentChecklist = {
  id: string;
  role: string;
  type: string;
  name: string;
  time_windows?: { start: string; end: string }[];
  interval_hours?: number;
  source_audit_id?: string;
  tasks: CurrentChecklistTask[];
};

type CurrentConfig = {
  roles: string[];
  roleNames?: Record<string, string>;
  checklists: CurrentChecklist[];
};

type AccessTokenResult = {
  accessToken: string;
  organizationInfo: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
  };
};

type Audit = {
  id: string;
  name: string;
  deleted: boolean;
  description?: string | null;
};

type AuditCheckList = {
  id: string;
  name: string;
  deleted: boolean;
  requireVerifiable?: boolean;
  order: number;
  auditId: string;
};

type AuditCheck = {
  id: string;
  name: string;
  deleted: boolean;
  description?: string | null;
  order: number;
  requiredQuestion?: boolean;
  question?: string | null;
  canSkipTask?: boolean;
  weight?: number;
  checkListId: string;
};

type CommonNomenclatureResponse = {
  roles: JsonRecord[];
  workPlaces: JsonRecord[];
  employees: JsonRecord[];
};

type InspectorNomenclatureResponse = {
  audits: Audit[];
  checkLists: AuditCheckList[];
  tasks: AuditCheck[];
};

type ProcessedCheck = {
  id: string;
  taskTemplateId?: string | null;
  name: string;
  description?: string | null;
  note?: string | null;
  order: number;
  question?: string | null;
  answer?: string | null;
  checkResult?: number | null;
  taskType?: number | null;
  imageUrls?: string | null;
};

type ProcessedCheckList = {
  id: string;
  checkListTemplateId?: string | null;
  name: string;
  order: number;
  processedChecks: ProcessedCheck[];
};

type ProcessedAudit = {
  id: string;
  name: string;
  auditTemplateId: string;
  inspectorId?: string;
  selectedInspectObjectId?: string;
  startTime?: string;
  endTime?: string | null;
  isClosed?: boolean;
  result?: number;
  checkLists: ProcessedCheckList[];
};

type TaskStats = {
  total: number;
  withPhotos: number;
  withAnswers: number;
  samples: string[];
};

type MatchInfo = {
  auditId: string;
  auditName: string;
  checklistId: string;
  checklistName: string;
  score: number;
};

type PhotoManifestItem = {
  auditId: string;
  auditName: string;
  auditTemplateId: string;
  startedAt: string | null;
  endedAt: string | null;
  checklistId: string;
  checklistName: string;
  taskTemplateId: string | null;
  taskName: string;
  imageUrls: string[];
};

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const exact = process.argv.find((arg) => arg.startsWith(prefix));
  if (exact) return exact.slice(prefix.length);

  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0) return process.argv[index + 1];

  return undefined;
}

function parseNumberArg(name: string, fallback: number): number {
  const value = getArg(name);
  if (!value) return fallback;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntegerArg(name: string): number | null {
  const value = getArg(name);
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanArg(name: string, fallback: boolean): boolean {
  const value = getArg(name);
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function getRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? (value as JsonRecord) : {};
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unwrapNamedPayload<T>(payload: unknown, key: string): T {
  const record = getRecord(payload);
  return ((record[key] ?? payload) as T);
}

async function apiGet<T>(pathname: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GET ${url.pathname} failed: ${response.status} ${errorText}`);
  }

  return (await response.json()) as T;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

function scoreChecklistMatch(auditName: string, checklistName: string): number {
  const auditNorm = normalizeText(auditName);
  const checklistNorm = normalizeText(checklistName);

  if (!auditNorm || !checklistNorm) return 0;
  if (auditNorm === checklistNorm) return 1;

  const auditTokens = new Set(tokenize(auditName));
  const checklistTokens = new Set(tokenize(checklistName));

  let overlap = 0;
  for (const token of auditTokens) {
    if (checklistTokens.has(token)) {
      overlap += 1;
    }
  }

  const union = new Set([...auditTokens, ...checklistTokens]).size || 1;
  const jaccard = overlap / union;
  const containsBonus =
    auditNorm.includes(checklistNorm) || checklistNorm.includes(auditNorm) ? 0.2 : 0;

  return Math.min(1, jaccard + containsBonus);
}

function getChecklistSearchLabels(checklist: CurrentChecklist): string[] {
  const roleAliases: Record<string, string[]> = {
    manager: ['manager', 'менеджер'],
    waiter: ['waiter', 'официант'],
    cleaner: ['cleaner', 'cleaning', 'уборка', 'клинер'],
    cook: ['cook', 'повар', 'curry men', 'kitchen'],
    sous_chef: ['sous chef', 'sous_chef', 'су шеф', 'су-шеф'],
    barista: ['barista', 'бариста', 'coffee point', 'кофепоинт', 'bar'],
  };

  const typeAliases: Record<string, string[]> = {
    open: ['open', 'opening', 'start of the day', 'открытие', 'начало дня'],
    close: ['close', 'closing', 'end of the day', 'закрытие', 'конец дня', 'окончание дня'],
    periodic: ['periodic', 'обход', 'zones', 'регулярный'],
    handover_open: ['handover', 'пересменка', 'открытие'],
    handover_close: ['handover', 'пересменка', 'закрытие'],
  };

  const labels = new Set<string>([
    checklist.name,
    checklist.id.replace(/_/g, ' '),
  ]);

  const roleLabel = roleAliases[checklist.role] ?? [];
  const typeLabel = typeAliases[checklist.type] ?? [];
  if (roleLabel.length > 0 || typeLabel.length > 0) {
    labels.add([...roleLabel, ...typeLabel].join(' '));
  }

  return [...labels];
}

function slugify(value: string): string {
  const normalized = normalizeText(value);
  return normalized.replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'audit';
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').slice(0, 120);
}

function collectTaskStats(processedAudits: ProcessedAudit[]): Map<string, TaskStats> {
  const stats = new Map<string, TaskStats>();

  for (const audit of processedAudits) {
    for (const checkList of audit.checkLists) {
      for (const check of checkList.processedChecks) {
        const taskTemplateId = getString(check.taskTemplateId);
        if (!taskTemplateId) continue;

        const imageUrls = splitImageUrls(check.imageUrls);
        const current = stats.get(taskTemplateId) ?? {
          total: 0,
          withPhotos: 0,
          withAnswers: 0,
          samples: [],
        };

        current.total += 1;
        if (imageUrls.length > 0) {
          current.withPhotos += 1;
          if (current.samples.length < 3) {
            current.samples.push(...imageUrls.slice(0, 3 - current.samples.length));
          }
        }

        if (getString(check.answer)) {
          current.withAnswers += 1;
        }

        stats.set(taskTemplateId, current);
      }
    }
  }

  return stats;
}

function splitImageUrls(value: string | null | undefined): string[] {
  if (!value) return [];

  return value
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function looksLikePhotoTask(task: AuditCheck): boolean {
  const haystack = [task.name, task.description ?? '', task.question ?? '']
    .join(' ')
    .toLowerCase();

  return [
    'фото',
    'сфот',
    'селфи',
    'photo',
    'picture',
    'image',
    'сделать фотограф',
    'send a photo',
  ].some((needle) => haystack.includes(needle));
}

function inferTaskType(task: AuditCheck, stats: TaskStats | undefined): 'photo' | 'confirm' {
  if (stats && stats.withPhotos > 0) {
    return 'photo';
  }

  if (looksLikePhotoTask(task)) {
    return 'photo';
  }

  return 'confirm';
}

function buildCurrentConfigDraft(
  currentConfig: CurrentConfig,
  inspectorNomenclature: InspectorNomenclatureResponse,
  taskStats: Map<string, TaskStats>,
  matches: MatchInfo[],
): CurrentConfig {
  const checkListsByAudit = groupBy(inspectorNomenclature.checkLists, (item) => item.auditId);
  const tasksByChecklist = groupBy(inspectorNomenclature.tasks, (item) => item.checkListId);
  const matchByChecklistId = new Map(matches.map((match) => [match.checklistId, match]));

  return {
    roles: currentConfig.roles,
    roleNames: currentConfig.roleNames,
    checklists: currentConfig.checklists.map((checklist) => {
      const match = matchByChecklistId.get(checklist.id);
      if (!match) return checklist;

      const audit = inspectorNomenclature.audits.find((item) => item.id === match.auditId);
      if (!audit) return checklist;

      const blocks = (checkListsByAudit.get(audit.id) ?? [])
        .filter((item) => !item.deleted)
        .sort((a, b) => a.order - b.order);

      const tasks: CurrentChecklistTask[] = [];
      let order = 0;

      for (const block of blocks) {
        const blockTasks = (tasksByChecklist.get(block.id) ?? [])
          .filter((item) => !item.deleted)
          .sort((a, b) => a.order - b.order);

        for (const task of blockTasks) {
          tasks.push({
            order,
            text: task.name,
            type: inferTaskType(task, taskStats.get(task.id)),
            section: block.name,
            weight: task.weight ?? 50,
            can_skip: task.canSkipTask ?? false,
            create_violation_on_no: true,
            ai_rule: null,
            reference_photo: null,
          });
          order += 1;
        }
      }

      return {
        ...checklist,
        name: audit.name,
        source_audit_id: audit.id,
        tasks: tasks.length > 0 ? tasks : checklist.tasks,
      };
    }),
  };
}

function buildPhotoManifest(processedAudits: ProcessedAudit[]): PhotoManifestItem[] {
  const items: PhotoManifestItem[] = [];

  for (const audit of processedAudits) {
    for (const checkList of audit.checkLists) {
      for (const check of checkList.processedChecks) {
        const imageUrls = splitImageUrls(check.imageUrls);
        if (imageUrls.length === 0) continue;

        items.push({
          auditId: audit.id,
          auditName: audit.name,
          auditTemplateId: audit.auditTemplateId,
          startedAt: audit.startTime ?? null,
          endedAt: audit.endTime ?? null,
          checklistId: checkList.id,
          checklistName: checkList.name,
          taskTemplateId: check.taskTemplateId ?? null,
          taskName: check.name,
          imageUrls,
        });
      }
    }
  }

  return items;
}

function buildMatches(audits: Audit[], currentChecklists: CurrentChecklist[], threshold: number): MatchInfo[] {
  const checklistsById = new Map(currentChecklists.map((item) => [item.id, item]));
  const candidates: MatchInfo[] = [];
  const matches: MatchInfo[] = [];
  const usedAuditIds = new Set<string>();
  const usedChecklistIds = new Set<string>();

  for (const [auditId, checklistId] of Object.entries(MANUAL_CHECKLIST_MAPPING)) {
    const audit = audits.find((item) => item.id === auditId && !item.deleted);
    const checklist = checklistsById.get(checklistId);
    if (!audit || !checklist) continue;

    matches.push({
      auditId: audit.id,
      auditName: audit.name,
      checklistId: checklist.id,
      checklistName: checklist.name,
      score: 1,
    });

    usedAuditIds.add(audit.id);
    usedChecklistIds.add(checklist.id);
  }

  for (const audit of audits.filter((item) => !item.deleted)) {
    if (usedAuditIds.has(audit.id)) continue;

    for (const checklist of currentChecklists) {
      if (usedChecklistIds.has(checklist.id)) continue;

      const score = Math.max(
        ...getChecklistSearchLabels(checklist).map((label) => scoreChecklistMatch(audit.name, label)),
      );
      if (score >= threshold) {
        candidates.push({
          auditId: audit.id,
          auditName: audit.name,
          checklistId: checklist.id,
          checklistName: checklist.name,
          score,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (usedAuditIds.has(candidate.auditId) || usedChecklistIds.has(candidate.checklistId)) {
      continue;
    }

    usedAuditIds.add(candidate.auditId);
    usedChecklistIds.add(candidate.checklistId);
    matches.push(candidate);
  }

  return matches;
}

function groupBy<T>(items: T[], keySelector: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = keySelector(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return groups;
}

function adaptProcessedAudits(raw: unknown, maxAudits: number | null): ProcessedAudit[] {
  const payload = unwrapNamedPayload<unknown[]>(raw, 'processedAudits');
  const audits = ensureArray<unknown>(payload).map((item) => {
    const record = getRecord(item);
    const checkListsRaw = record['checkLists'] ?? record['сheckLists'];

    const checkLists = ensureArray<unknown>(checkListsRaw).map((checkListItem) => {
      const checkListRecord = getRecord(checkListItem);
      const checksRaw = checkListRecord['processedChecks'] ?? checkListRecord['ProcesseChecks'];

      const processedChecks = ensureArray<unknown>(checksRaw).map((checkItem) => {
        const checkRecord = getRecord(checkItem);

        return {
          id: getString(checkRecord['id']) ?? '',
          taskTemplateId: getString(checkRecord['taskTemplateId']),
          name: getString(checkRecord['name']) ?? 'Без названия',
          description: getString(checkRecord['description']),
          note: getString(checkRecord['note']),
          order: getNumber(checkRecord['order']) ?? 0,
          question: getString(checkRecord['question']),
          answer: getString(checkRecord['answer']),
          checkResult: getNumber(checkRecord['checkResult']),
          taskType: getNumber(checkRecord['taskType']),
          imageUrls: getString(checkRecord['imageUrls']),
        } satisfies ProcessedCheck;
      });

      return {
        id: getString(checkListRecord['id']) ?? '',
        checkListTemplateId: getString(checkListRecord['checkListTemplateId']),
        name: getString(checkListRecord['name']) ?? 'Без названия',
        order: getNumber(checkListRecord['order']) ?? 0,
        processedChecks,
      } satisfies ProcessedCheckList;
    });

    return {
      id: getString(record['id']) ?? '',
      name: getString(record['name']) ?? 'Без названия',
      auditTemplateId: getString(record['auditTemplateId']) ?? '',
      inspectorId: getString(record['inspectorId']) ?? undefined,
      selectedInspectObjectId: getString(record['selectedInspectObjectId']) ?? undefined,
      startTime: getString(record['startTime']) ?? undefined,
      endTime: getString(record['endTime']),
      isClosed: Boolean(record['isClosed']),
      result: getNumber(record['result']) ?? undefined,
      checkLists,
    } satisfies ProcessedAudit;
  });

  if (maxAudits != null) {
    return audits.slice(0, maxAudits);
  }

  return audits;
}

async function downloadPhotos(items: PhotoManifestItem[], outputDir: string): Promise<void> {
  const photosDir = path.join(outputDir, 'photos');
  await mkdir(photosDir, { recursive: true });

  let fileCounter = 0;
  for (const item of items) {
    const auditDir = path.join(
      photosDir,
      `${sanitizeFileName(item.auditName)}_${sanitizeFileName(item.auditId)}`,
    );
    await mkdir(auditDir, { recursive: true });

    for (let index = 0; index < item.imageUrls.length; index += 1) {
      const url = item.imageUrls[index];
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.status} ${url}`);
      }

      const ext = path.extname(new URL(url).pathname) || '.jpg';
      const fileName = `${String(fileCounter).padStart(5, '0')}_${sanitizeFileName(item.taskName)}_${index + 1}${ext}`;
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(path.join(auditDir, fileName), buffer);
      fileCounter += 1;
    }
  }
}

async function main(): Promise<void> {
  const login = getArg('login') ?? process.env.SERVICE_INSPECTOR_LOGIN;
  const password = getArg('password') ?? process.env.SERVICE_INSPECTOR_PASSWORD;

  if (!login || !password) {
    throw new Error(
      'Missing credentials. Use SERVICE_INSPECTOR_LOGIN / SERVICE_INSPECTOR_PASSWORD or --login / --password.',
    );
  }

  const fromDate = getArg('from');
  const toDate = getArg('to');
  const outputDirArg = getArg('output-dir');
  const downloadPhotosEnabled = parseBooleanArg('download-photos', false);
  const matchThreshold = parseNumberArg('match-threshold', DEFAULT_MATCH_THRESHOLD);
  const maxAudits = parseIntegerArg('max-audits');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = outputDirArg
    ? path.resolve(outputDirArg)
    : path.join(DEFAULT_OUTPUT_ROOT, timestamp);

  await mkdir(outputDir, { recursive: true });

  const authRaw = await apiGet<unknown>('/auth/access_token', {
    user_login: login,
    user_secret: password,
  });

  const accessTokenResult = unwrapNamedPayload<AccessTokenResult>(authRaw, 'accessTokenResult');
  const accessToken = accessTokenResult.accessToken;
  const orgId = accessTokenResult.organizationInfo.id;

  const [commonRaw, inspectorRaw, processedRaw] = await Promise.all([
    apiGet<unknown>('/common/get_nomenclature', {
      access_token: accessToken,
      org_id: orgId,
    }),
    apiGet<unknown>('/inspector/get_nomenclature', {
      access_token: accessToken,
      org_id: orgId,
    }),
    apiGet<unknown>('/inspector/get_processed_audits_with_details', {
      access_token: accessToken,
      org_id: orgId,
      from_date: fromDate,
      to_date: toDate,
    }),
  ]);

  const commonNomenclature = unwrapNamedPayload<CommonNomenclatureResponse>(
    commonRaw,
    'commonNomenclatureResponse',
  );
  const inspectorNomenclature = unwrapNamedPayload<InspectorNomenclatureResponse>(
    inspectorRaw,
    'inspectorNomenclatureResponse',
  );
  const processedAudits = adaptProcessedAudits(processedRaw, maxAudits);

  const currentConfigPath = path.resolve('src', 'config', 'checklists.json');
  const currentConfig = JSON.parse(
    await readFile(currentConfigPath, 'utf8'),
  ) as CurrentConfig;

  const taskStats = collectTaskStats(processedAudits);
  const matches = buildMatches(
    inspectorNomenclature.audits,
    currentConfig.checklists,
    matchThreshold,
  );
  const draftConfig = buildCurrentConfigDraft(
    currentConfig,
    inspectorNomenclature,
    taskStats,
    matches,
  );
  const photoManifest = buildPhotoManifest(processedAudits);

  const matchedAuditIds = new Set(matches.map((item) => item.auditId));
  const unmatchedAudits = inspectorNomenclature.audits
    .filter((item) => !item.deleted)
    .filter((item) => !matchedAuditIds.has(item.id))
    .map((item) => ({
      auditId: item.id,
      auditName: item.name,
      suggestedId: `si_${slugify(item.name)}`,
    }));

  const metadata = {
    exportedAt: new Date().toISOString(),
    apiBase: API_BASE,
    organization: accessTokenResult.organizationInfo,
    summary: {
      audits: inspectorNomenclature.audits.filter((item) => !item.deleted).length,
      matchedAudits: matches.length,
      unmatchedAudits: unmatchedAudits.length,
      processedAudits: processedAudits.length,
      photoItems: photoManifest.length,
    },
    filters: {
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
      maxAudits,
      matchThreshold,
    },
  };

  await writeFile(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'common-nomenclature.json'),
    JSON.stringify(commonNomenclature, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'inspector-nomenclature.json'),
    JSON.stringify(inspectorNomenclature, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'processed-audits-with-details.json'),
    JSON.stringify(processedAudits, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'checklists.bot-draft.json'),
    JSON.stringify(draftConfig, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'audit-match-report.json'),
    JSON.stringify({ matches, unmatchedAudits }, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'photo-manifest.json'),
    JSON.stringify(photoManifest, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'photo-manifest.jsonl'),
    `${photoManifest.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  );

  if (downloadPhotosEnabled && photoManifest.length > 0) {
    await downloadPhotos(photoManifest, outputDir);
  }

  console.log(`Service Inspector export completed: ${outputDir}`);
  console.log(
    JSON.stringify(
      {
        organization: accessTokenResult.organizationInfo.name,
        matchedAudits: matches.length,
        unmatchedAudits: unmatchedAudits.length,
        processedAudits: processedAudits.length,
        photoItems: photoManifest.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
