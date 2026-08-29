import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import { env } from '../config/env';

const logDir = path.resolve(env.LOG_DIR);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, correlationId, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        const cid = correlationId ? ` [${correlationId}]` : '';
        return `${timestamp} ${level}${cid}: ${message}${metaStr}`;
      })
    ),
  }),
];

// ⚠️ Syaratnya dulu `env.NODE_ENV === 'production'`, dan itu keliru arah.
// Di production ada agregator log dan orang yang memantau; di DEVELOPMENT justru
// tidak ada apa-apa selain terminal yang menjalankan `tsx watch` — dan terminal
// itu tidak bisa dibaca ulang, tidak bisa di-grep, dan hilang saat ditutup.
//
// Akibatnya nyata: 30 Juli 2026, gejala "buffer & fakta masih 0" ditebak EMPAT
// putaran berturut-turut karena satu-satunya bukti yang bisa menjawabnya
// (`[HL/sapu] N buffer diperiksa…`) tidak pernah bisa dibaca. Empat perbaikan
// benar, tapi tidak satu pun bisa DIBUKTIKAN.
//
// Log yang tidak bisa dibaca ulang sama nilainya dengan tidak ada log.
if (env.LOG_TO_FILE) {
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      dirname: logDir,
      maxSize: '100m',
      maxFiles: '30d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  );
}

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  transports,
});
