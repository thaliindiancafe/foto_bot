export type RoleKey =
  | 'manager'
  | 'waiter'
  | 'helper'
  | 'barista'
  | 'hostess';

export type LanguageCode = 'ru' | 'en' | 'hi' | 'fa' | 'uz' | 'tg' | 'ky' | 'ur';

export type LanguageConfig = {
  code: LanguageCode;
  label: string;
  nativeLabel: string;
};

export type RoleConfig = {
  key: RoleKey;
  label: string;
  languages: LanguageCode[];
};

export const allLanguages: LanguageConfig[] = [
  { code: 'ru', label: 'Русский', nativeLabel: '🇷🇺 Русский' },
  { code: 'en', label: 'English', nativeLabel: '🇬🇧 English' },
  { code: 'hi', label: 'हिन्दी', nativeLabel: '🇮🇳 हिन्दी (Hindi)' },
  { code: 'fa', label: 'فارسی', nativeLabel: '🇮🇷 فارسی (Farsi)' },
  { code: 'uz', label: 'Oʻzbekcha', nativeLabel: '🇺🇿 Oʻzbekcha (Uzbek)' },
  { code: 'tg', label: 'Тоҷикӣ', nativeLabel: '🇹🇯 Тоҷикӣ (Tajik)' },
  { code: 'ky', label: 'Кыргызча', nativeLabel: '🇰🇬 Кыргызча (Kyrgyz)' },
  { code: 'ur', label: 'اردو', nativeLabel: '🇵🇰 اردو (Urdu)' },
];

// Активные (доступные для выбора) языки. Остальные коды из LanguageCode
// (uz / tg / ky / ur) остаются полностью определёнными в коде — переводы UI,
// поддержка middleware, batch-переводчик — всё готово. Чтобы их включить,
// достаточно добавить нужный код в ACTIVE_LANG_CODES и в BATCH_TARGET_LANGS
// (см. src/services/checklistTranslationService.ts).
const ACTIVE_LANG_CODES: LanguageCode[] = ['ru', 'en', 'hi', 'fa'];

/**
 * Языки, которые сейчас показываются в picker-е и доступны для выбора. Это
 * `allLanguages`, отфильтрованный по `ACTIVE_LANG_CODES`. Используйте при
 * построении клавиатур; для проверки введённого текста безопаснее ходить в
 * `allLanguages` (чтобы пользователь со старым кодом из БД не падал).
 */
export const activeLanguages: LanguageConfig[] = ACTIVE_LANG_CODES
  .map((code) => allLanguages.find((l) => l.code === code))
  .filter((l): l is LanguageConfig => l != null);

export const roles: RoleConfig[] = [
  { key: 'manager', label: 'Менеджер', languages: ACTIVE_LANG_CODES },
  { key: 'waiter', label: 'Официант', languages: ACTIVE_LANG_CODES },
  { key: 'helper', label: 'Хелпер', languages: ACTIVE_LANG_CODES },
  { key: 'barista', label: 'Бариста', languages: ACTIVE_LANG_CODES },
  { key: 'hostess', label: 'Хостес', languages: ACTIVE_LANG_CODES },
];

export function findRoleByLabel(label: string): RoleConfig | undefined {
  const normalized = label.trim().toLowerCase();
  return roles.find((role) => role.label.toLowerCase() === normalized);
}

export function findRoleByKey(key: string): RoleConfig | undefined {
  return roles.find((role) => role.key === key);
}

export function getLanguageConfig(code: string): LanguageConfig | undefined {
  return allLanguages.find((lang) => lang.code === code);
}

export function findLanguageByLabel(label: string): LanguageConfig | undefined {
  const normalized = label.trim();
  return allLanguages.find(
    (lang) =>
      lang.nativeLabel === normalized ||
      lang.label.toLowerCase() === normalized.toLowerCase() ||
      lang.code === normalized.toLowerCase(),
  );
}

export function getLanguagesForRole(roleKey: string): LanguageConfig[] {
  const role = findRoleByKey(roleKey);
  if (!role) return [];
  return role.languages
    .map((code) => allLanguages.find((lang) => lang.code === code))
    .filter((lang): lang is LanguageConfig => lang != null);
}

// Returns roles that have the given language available.
export function getRolesForLanguage(languageCode: string): RoleConfig[] {
  return roles.filter((role) => role.languages.includes(languageCode as LanguageCode));
}

// Universal i18n strings for the registration / menu flow.
// For unsupported languages, fall back to English (then Russian if needed).
type UiKey =
  | 'welcome'
  | 'choose_language'
  | 'enter_name'
  | 'name_too_short'
  | 'choose_role'
  | 'role_not_recognized'
  | 'registration_complete'
  | 'role_added'
  | 'role_label_name'
  | 'role_label_role'
  | 'role_label_language'
  | 'role_label_location'
  | 'choose_extra_role'
  | 'all_roles_added'
  | 'switch_role_btn'
  | 'add_role_btn'
  | 'choose_role_to_switch'
  | 'cant_switch_during_run'
  | 'cant_register_during_run'
  | 'available_checklists'
  | 'no_checklists_now'
  | 'all_done_today'
  | 'next_checklist_at'
  | 'send_photo'
  | 'photo_received'
  | 'photo_check_in_progress'
  | 'main_menu_button'
  | 'start_button'
  | 'switch_role_btn_plain'
  | 'register_button'
  | 'deferred_menu_tap_hint';

const ui: Record<LanguageCode, Record<UiKey, string>> = {
  ru: {
    welcome: 'Привет! Регистрация открыта.',
    choose_language: 'Выберите язык / Choose language',
    enter_name: 'Как тебя лучше называть? Напиши имя/фамилию одним сообщением.',
    name_too_short: 'Имя слишком короткое, напиши, пожалуйста, ещё раз.',
    choose_role: 'Выбери свою роль:',
    role_not_recognized: 'Не удалось распознать роль. Выбери вариант из клавиатуры.',
    registration_complete: 'Регистрация завершена ✅',
    role_added: '✅ Роль добавлена и сделана активной',
    role_label_name: 'Имя',
    role_label_role: 'Роль',
    role_label_language: 'Язык',
    role_label_location: 'Локация',
    choose_extra_role: 'Выбери дополнительную роль:',
    all_roles_added: 'Все роли уже добавлены.',
    switch_role_btn: '🔄 Сменить роль',
    add_role_btn: '➕ Добавить роль',
    choose_role_to_switch: 'Выберите роль:',
    cant_switch_during_run: 'Нельзя сменить роль во время чек-листа. Завершите его сначала.',
    cant_register_during_run: 'Нельзя перерегистрироваться во время чек-листа. Завершите его сначала.',
    available_checklists: 'Доступные чек-листы:',
    no_checklists_now: 'Все чек-листы на сегодня пройдены. Отличная работа!',
    all_done_today: 'Все чек-листы на сегодня пройдены.',
    next_checklist_at: 'Следующий чек-лист будет доступен в',
    send_photo: 'Пожалуйста, отправьте фото.',
    photo_received: '📷 Фото получено, идёт проверка...',
    photo_check_in_progress: 'Проверка фото...',
    main_menu_button: 'Меню',
    start_button: 'Старт',
    switch_role_btn_plain: 'Сменить роль',
    register_button: 'Регистрация',
    deferred_menu_tap_hint: '👇 Тапните на пункт ниже, чтобы открыть и пройти его. Если выполнить никак нельзя — внутри будет кнопка «⏭ Пропустить пункт» с обязательным комментарием.',
  },
  en: {
    welcome: 'Hi! Registration is open.',
    choose_language: 'Choose language / Выберите язык',
    enter_name: 'How should we call you? Send your full name in one message.',
    name_too_short: 'Name is too short, please try again.',
    choose_role: 'Choose your role:',
    role_not_recognized: 'Could not recognize the role. Pick one from the keyboard.',
    registration_complete: 'Registration completed ✅',
    role_added: '✅ Role added and made active',
    role_label_name: 'Name',
    role_label_role: 'Role',
    role_label_language: 'Language',
    role_label_location: 'Location',
    choose_extra_role: 'Choose an additional role:',
    all_roles_added: 'All roles are already added.',
    switch_role_btn: '🔄 Switch role',
    add_role_btn: '➕ Add role',
    choose_role_to_switch: 'Choose a role:',
    cant_switch_during_run: 'Cannot switch role during a checklist. Finish it first.',
    cant_register_during_run: 'Cannot re-register during a checklist. Finish it first.',
    available_checklists: 'Available checklists:',
    no_checklists_now: 'All checklists for today are completed. Great job!',
    all_done_today: 'All checklists for today are completed.',
    next_checklist_at: 'Next checklist will be available at',
    send_photo: 'Please send a photo.',
    photo_received: '📷 Photo received, checking...',
    photo_check_in_progress: 'Checking photo...',
    main_menu_button: 'Menu',
    start_button: 'Start',
    switch_role_btn_plain: 'Switch role',
    register_button: 'Registration',
    deferred_menu_tap_hint: '👇 Tap an item below to open and complete it. If it truly cannot be done — inside there is a «⏭ Skip item» button with a mandatory comment.',
  },
  hi: {
    welcome: 'नमस्ते! पंजीकरण खुला है।',
    choose_language: 'भाषा चुनें / Choose language',
    enter_name: 'आपको क्या कहकर बुलाएं? अपना पूरा नाम एक संदेश में भेजें।',
    name_too_short: 'नाम बहुत छोटा है, कृपया फिर से लिखें।',
    choose_role: 'अपनी भूमिका चुनें:',
    role_not_recognized: 'भूमिका नहीं पहचानी गई। कीबोर्ड से कोई विकल्प चुनें।',
    registration_complete: 'पंजीकरण पूरा हुआ ✅',
    role_added: '✅ भूमिका जोड़ी गई और सक्रिय की गई',
    role_label_name: 'नाम',
    role_label_role: 'भूमिका',
    role_label_language: 'भाषा',
    role_label_location: 'स्थान',
    choose_extra_role: 'अतिरिक्त भूमिका चुनें:',
    all_roles_added: 'सभी भूमिकाएं पहले से जोड़ी गई हैं।',
    switch_role_btn: '🔄 भूमिका बदलें',
    add_role_btn: '➕ भूमिका जोड़ें',
    choose_role_to_switch: 'भूमिका चुनें:',
    cant_switch_during_run: 'चेकलिस्ट के दौरान भूमिका नहीं बदल सकते। पहले इसे पूरा करें।',
    cant_register_during_run: 'चेकलिस्ट के दौरान फिर से पंजीकरण नहीं हो सकता।',
    available_checklists: 'उपलब्ध चेकलिस्ट:',
    no_checklists_now: 'आज के सभी चेकलिस्ट पूरे हो गए हैं। शानदार काम!',
    all_done_today: 'आज के सभी चेकलिस्ट पूरे हो गए।',
    next_checklist_at: 'अगला चेकलिस्ट उपलब्ध होगा',
    send_photo: 'कृपया एक फोटो भेजें।',
    photo_received: '📷 फोटो मिली, जांच हो रही है...',
    photo_check_in_progress: 'फोटो जांच हो रही है...',
    main_menu_button: 'मेनू',
    start_button: 'शुरू',
    switch_role_btn_plain: 'भूमिका बदलें',
    register_button: 'पंजीकरण',
    deferred_menu_tap_hint: '👇 खोलने और पूरा करने के लिए नीचे किसी आइटम पर टैप करें। यदि करना बिल्कुल संभव नहीं है — अंदर अनिवार्य टिप्पणी के साथ «⏭ आइटम छोड़ें» बटन होगा।',
  },
  fa: {
    welcome: 'سلام! ثبت‌نام باز است.',
    choose_language: 'زبان را انتخاب کنید / Choose language',
    enter_name: 'چه نامی برای شما استفاده کنیم؟ نام کامل خود را در یک پیام بفرستید.',
    name_too_short: 'نام خیلی کوتاه است، لطفاً دوباره وارد کنید.',
    choose_role: 'نقش خود را انتخاب کنید:',
    role_not_recognized: 'نقش شناسایی نشد. یکی از گزینه‌های کیبورد را انتخاب کنید.',
    registration_complete: 'ثبت‌نام تکمیل شد ✅',
    role_added: '✅ نقش اضافه و فعال شد',
    role_label_name: 'نام',
    role_label_role: 'نقش',
    role_label_language: 'زبان',
    role_label_location: 'مکان',
    choose_extra_role: 'یک نقش اضافی انتخاب کنید:',
    all_roles_added: 'همه نقش‌ها قبلاً اضافه شده‌اند.',
    switch_role_btn: '🔄 تغییر نقش',
    add_role_btn: '➕ افزودن نقش',
    choose_role_to_switch: 'نقش را انتخاب کنید:',
    cant_switch_during_run: 'در حین چک‌لیست نمی‌توان نقش را تغییر داد. ابتدا آن را به پایان برسانید.',
    cant_register_during_run: 'در حین چک‌لیست نمی‌توان دوباره ثبت‌نام کرد.',
    available_checklists: 'چک‌لیست‌های موجود:',
    no_checklists_now: 'همه چک‌لیست‌های امروز انجام شده. عالی!',
    all_done_today: 'همه چک‌لیست‌های امروز انجام شده.',
    next_checklist_at: 'چک‌لیست بعدی در دسترس خواهد بود ساعت',
    send_photo: 'لطفاً یک عکس بفرستید.',
    photo_received: '📷 عکس دریافت شد، در حال بررسی...',
    photo_check_in_progress: 'در حال بررسی عکس...',
    main_menu_button: 'منو',
    start_button: 'شروع',
    switch_role_btn_plain: 'تغییر نقش',
    register_button: 'ثبت‌نام',
    deferred_menu_tap_hint: '👇 برای باز کردن و انجام دادن یک مورد، روی آن در پایین ضربه بزنید. اگر واقعاً امکان‌پذیر نیست — داخل، دکمه «⏭ رد کردن مورد» همراه با توضیح اجباری وجود دارد.',
  },
  uz: {
    welcome: 'Salom! Roʻyxatdan oʻtish ochiq.',
    choose_language: 'Tilni tanlang / Choose language',
    enter_name: 'Sizni qanday chaqirsak boʻladi? Toʻliq ismingizni bitta xabarda yuboring.',
    name_too_short: 'Ism juda qisqa, iltimos qaytadan yozing.',
    choose_role: 'Rolingizni tanlang:',
    role_not_recognized: 'Rol aniqlanmadi. Klaviaturadan birini tanlang.',
    registration_complete: 'Roʻyxatdan oʻtish yakunlandi ✅',
    role_added: '✅ Rol qoʻshildi va faollashtirildi',
    role_label_name: 'Ism',
    role_label_role: 'Rol',
    role_label_language: 'Til',
    role_label_location: 'Joy',
    choose_extra_role: 'Qoʻshimcha rol tanlang:',
    all_roles_added: 'Barcha rollar allaqachon qoʻshilgan.',
    switch_role_btn: '🔄 Rolni almashtirish',
    add_role_btn: '➕ Rol qoʻshish',
    choose_role_to_switch: 'Rolni tanlang:',
    cant_switch_during_run: 'Chek-list davomida rolni almashtirib boʻlmaydi. Avval uni yakunlang.',
    cant_register_during_run: 'Chek-list davomida qayta roʻyxatdan oʻtib boʻlmaydi.',
    available_checklists: 'Mavjud chek-listlar:',
    no_checklists_now: 'Bugungi barcha chek-listlar bajarildi. Aʼlo ish!',
    all_done_today: 'Bugungi barcha chek-listlar bajarildi.',
    next_checklist_at: 'Keyingi chek-list mavjud boʻladi:',
    send_photo: 'Iltimos, rasm yuboring.',
    photo_received: '📷 Rasm qabul qilindi, tekshirilmoqda...',
    photo_check_in_progress: 'Rasm tekshirilmoqda...',
    main_menu_button: 'Menyu',
    start_button: 'Boshlash',
    switch_role_btn_plain: 'Rolni almashtirish',
    register_button: 'Roʻyxatdan oʻtish',
    deferred_menu_tap_hint: '👇 Punktni ochish va bajarish uchun quyidagi punkt ustiga bosing. Agar bajarib boʻlmasa — punkt ichida majburiy izoh bilan «⏭ Punktni oʻtkazib yuborish» tugmasi boʻladi.',
  },
  tg: {
    welcome: 'Салом! Бақайдгирӣ кушода аст.',
    choose_language: 'Забонро интихоб кунед / Choose language',
    enter_name: 'Шуморо чӣ хел номидан мумкин? Номи пурраи худро дар як паём фиристед.',
    name_too_short: 'Ном хеле кӯтоҳ аст, лутфан аз нав ворид кунед.',
    choose_role: 'Нақши худро интихоб кунед:',
    role_not_recognized: 'Нақш муайян нашуд. Аз клавиатура якеро интихоб кунед.',
    registration_complete: 'Бақайдгирӣ ба анҷом расид ✅',
    role_added: '✅ Нақш илова шуд ва фаъол гардид',
    role_label_name: 'Ном',
    role_label_role: 'Нақш',
    role_label_language: 'Забон',
    role_label_location: 'Маҳал',
    choose_extra_role: 'Нақши иловагӣ интихоб кунед:',
    all_roles_added: 'Ҳамаи нақшҳо аллакай илова шудаанд.',
    switch_role_btn: '🔄 Иваз кардани нақш',
    add_role_btn: '➕ Илова кардани нақш',
    choose_role_to_switch: 'Нақшро интихоб кунед:',
    cant_switch_during_run: 'Дар вақти иҷрои чек-лист иваз кардани нақш мумкин нест. Аввал онро ба анҷом расонед.',
    cant_register_during_run: 'Дар вақти иҷрои чек-лист аз нав бақайд гирифтан мумкин нест.',
    available_checklists: 'Чек-листҳои дастрас:',
    no_checklists_now: 'Ҳамаи чек-листҳои имрӯза анҷом ёфтанд. Кори аъло!',
    all_done_today: 'Ҳамаи чек-листҳои имрӯза анҷом ёфтанд.',
    next_checklist_at: 'Чек-листи навбатӣ дастрас мешавад дар',
    send_photo: 'Лутфан, акс фиристед.',
    photo_received: '📷 Акс қабул шуд, санҷида мешавад...',
    photo_check_in_progress: 'Акс санҷида мешавад...',
    main_menu_button: 'Меню',
    start_button: 'Сар кардан',
    switch_role_btn_plain: 'Иваз кардани нақш',
    register_button: 'Бақайдгирӣ',
    deferred_menu_tap_hint: '👇 Барои кушодан ва иҷро кардани пункт, ба пункти зер зер занед. Агар ҳеҷ имкон набошад — дар дохили пункт тугмаи «⏭ Гузаронидани пункт» бо шарҳи ҳатмӣ ҳаст.',
  },
  ky: {
    welcome: 'Салам! Каттоо ачык.',
    choose_language: 'Тилди тандаңыз / Choose language',
    enter_name: 'Сизди кантип атаганды каалайсыз? Толук атыңызды бир билдирүүдө жөнөтүңүз.',
    name_too_short: 'Аты өтө кыска, кайра жазып көрүңүз.',
    choose_role: 'Ролуңузду тандаңыз:',
    role_not_recognized: 'Рол таанылган жок. Клавиатурадан тандаңыз.',
    registration_complete: 'Каттоо аяктады ✅',
    role_added: '✅ Рол кошулду жана активдештирилди',
    role_label_name: 'Аты',
    role_label_role: 'Ролу',
    role_label_language: 'Тили',
    role_label_location: 'Жайы',
    choose_extra_role: 'Кошумча рол тандаңыз:',
    all_roles_added: 'Бардык ролдор мурунтан кошулган.',
    switch_role_btn: '🔄 Ролду алмаштыруу',
    add_role_btn: '➕ Рол кошуу',
    choose_role_to_switch: 'Ролду тандаңыз:',
    cant_switch_during_run: 'Чек-лист учурунда ролду алмаштыруу мүмкүн эмес. Адегенде аны аяктаңыз.',
    cant_register_during_run: 'Чек-лист учурунда кайра катталуу мүмкүн эмес.',
    available_checklists: 'Жеткиликтүү чек-листтер:',
    no_checklists_now: 'Бүгүнкү бардык чек-листтер бүттү. Сонун иш!',
    all_done_today: 'Бүгүнкү бардык чек-листтер бүттү.',
    next_checklist_at: 'Кийинки чек-лист жеткиликтүү болот:',
    send_photo: 'Сүрөт жөнөтүңүз.',
    photo_received: '📷 Сүрөт кабыл алынды, текшерилүүдө...',
    photo_check_in_progress: 'Сүрөт текшерилүүдө...',
    main_menu_button: 'Меню',
    start_button: 'Баштоо',
    switch_role_btn_plain: 'Ролду алмаштыруу',
    register_button: 'Каттоо',
    deferred_menu_tap_hint: '👇 Пунктту ачуу жана аткаруу үчүн төмөнкү пунктка таптап коюңуз. Эгер таптакыр аткара албасаңыз — пункттун ичинде милдеттүү комментарий менен «⏭ Пунктту өткөрүп жиберүү» баскычы болот.',
  },
  ur: {
    welcome: 'سلام! رجسٹریشن کھلی ہے۔',
    choose_language: 'زبان منتخب کریں / Choose language',
    enter_name: 'آپ کو کس نام سے پکاریں؟ اپنا پورا نام ایک پیغام میں بھیجیں۔',
    name_too_short: 'نام بہت چھوٹا ہے، براہ کرم دوبارہ لکھیں۔',
    choose_role: 'اپنا کردار منتخب کریں:',
    role_not_recognized: 'کردار شناخت نہیں ہوا۔ کی بورڈ سے ایک منتخب کریں۔',
    registration_complete: 'رجسٹریشن مکمل ہو گئی ✅',
    role_added: '✅ کردار شامل اور فعال کر دیا گیا',
    role_label_name: 'نام',
    role_label_role: 'کردار',
    role_label_language: 'زبان',
    role_label_location: 'مقام',
    choose_extra_role: 'اضافی کردار منتخب کریں:',
    all_roles_added: 'تمام کردار پہلے سے شامل ہیں۔',
    switch_role_btn: '🔄 کردار تبدیل کریں',
    add_role_btn: '➕ کردار شامل کریں',
    choose_role_to_switch: 'کردار منتخب کریں:',
    cant_switch_during_run: 'چیک لسٹ کے دوران کردار تبدیل نہیں کیا جا سکتا۔ پہلے اسے مکمل کریں۔',
    cant_register_during_run: 'چیک لسٹ کے دوران دوبارہ رجسٹریشن نہیں ہو سکتی۔',
    available_checklists: 'دستیاب چیک لسٹس:',
    no_checklists_now: 'آج کی تمام چیک لسٹس مکمل ہو گئیں۔ شاندار کام!',
    all_done_today: 'آج کی تمام چیک لسٹس مکمل ہو گئیں۔',
    next_checklist_at: 'اگلی چیک لسٹ دستیاب ہو گی',
    send_photo: 'براہ کرم تصویر بھیجیں۔',
    photo_received: '📷 تصویر موصول ہوئی، جانچ ہو رہی ہے...',
    photo_check_in_progress: 'تصویر کی جانچ ہو رہی ہے...',
    main_menu_button: 'مینو',
    start_button: 'شروع',
    switch_role_btn_plain: 'کردار تبدیل کریں',
    register_button: 'رجسٹریشن',
    deferred_menu_tap_hint: '👇 کسی آئٹم کو کھولنے اور مکمل کرنے کے لیے نیچے اس پر ٹیپ کریں۔ اگر واقعی ممکن نہ ہو — آئٹم کے اندر لازمی تبصرے کے ساتھ «⏭ آئٹم چھوڑیں» بٹن ہے۔',
  },
};

export function t(lang: string | null | undefined, key: UiKey): string {
  const code = (lang ?? 'ru') as LanguageCode;
  return ui[code]?.[key] ?? ui.ru[key];
}

// Главное меню: кнопки `Старт / Меню / Сменить роль / Регистрация` приходят
// на не-русском языке (i18n middleware переводит подписи). Чтобы хэндлер
// текста узнавал их в любом из поддерживаемых языков, собираем единый
// нормализованный реестр всех вариантов.
export type MenuButtonKey = 'start' | 'menu' | 'switch_role' | 'register';

const MENU_BUTTON_LABELS: Record<MenuButtonKey, ReadonlySet<string>> = (() => {
  const map: Record<MenuButtonKey, Set<string>> = {
    start: new Set(),
    menu: new Set(),
    switch_role: new Set(),
    register: new Set(),
  };
  for (const langCode of Object.keys(ui) as LanguageCode[]) {
    map.start.add(ui[langCode].start_button.toLowerCase());
    map.menu.add(ui[langCode].main_menu_button.toLowerCase());
    map.switch_role.add(ui[langCode].switch_role_btn_plain.toLowerCase());
    map.register.add(ui[langCode].register_button.toLowerCase());
  }
  return map;
})();

/**
 * Сопоставляет введённый пользователем текст с кнопкой главного меню в любом
 * из поддерживаемых языков. Для `register` сохраняем историческое поведение
 * `startsWith`, для остальных — строгое равенство (без учёта регистра/пробелов).
 */
export function getMenuButtonKey(text: string): MenuButtonKey | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (MENU_BUTTON_LABELS.start.has(normalized)) return 'start';
  if (MENU_BUTTON_LABELS.menu.has(normalized)) return 'menu';
  if (MENU_BUTTON_LABELS.switch_role.has(normalized)) return 'switch_role';
  for (const label of MENU_BUTTON_LABELS.register) {
    if (normalized.startsWith(label)) return 'register';
  }
  return null;
}

