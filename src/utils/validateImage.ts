import sharp from 'sharp';
import { config } from '../config/index.js';
import { readExifCapturedAt } from './exif.js';

const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'] as const;
const MIN_DIMENSION = 100;
const MAX_FUTURE_DRIFT_MINUTES = 5;

type ValidationResult =
  | { valid: true; width: number; height: number; capturedAt: Date | null }
  | { valid: false; reason: string };

export async function validateImage(buffer: Buffer): Promise<ValidationResult> {
  try {
    const metadata = await sharp(buffer).metadata();

    if (!metadata.format || !(ALLOWED_FORMATS as readonly string[]).includes(metadata.format)) {
      return {
        valid: false,
        reason: `Неподдерживаемый формат: ${metadata.format ?? 'неизвестен'}. Допустимые: JPEG, PNG, WebP.`,
      };
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
      return {
        valid: false,
        reason: `Изображение слишком маленькое (${width}x${height}). Минимум: ${MIN_DIMENSION}x${MIN_DIMENSION}px.`,
      };
    }

    const capturedAt = readExifCapturedAt(buffer);
    if (capturedAt && config.EXIF_MAX_AGE_MINUTES > 0) {
      const ageMs = Date.now() - capturedAt.getTime();
      const maxAgeMs = config.EXIF_MAX_AGE_MINUTES * 60_000;
      const futureDriftMs = MAX_FUTURE_DRIFT_MINUTES * 60_000;

      if (ageMs > maxAgeMs) {
        return {
          valid: false,
          reason: `Фото отклонено: EXIF-дата слишком старая. Нужен свежий снимок, сделанный не более ${config.EXIF_MAX_AGE_MINUTES} минут назад.`,
        };
      }

      if (ageMs < -futureDriftMs) {
        return {
          valid: false,
          reason: 'Фото отклонено: EXIF-дата некорректна. Проверьте дату и время на устройстве.',
        };
      }
    }

    return { valid: true, width, height, capturedAt };
  } catch {
    return {
      valid: false,
      reason: 'Не удалось обработать файл как изображение.',
    };
  }
}
