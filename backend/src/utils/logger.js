"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
var winston_1 = require("winston");
require("winston-daily-rotate-file");
var path_1 = require("path");
var env_1 = require("../config/env");
var logDir = path_1.default.resolve(env_1.env.LOG_DIR);
var transports = [
    new winston_1.default.transports.Console({
        format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.printf(function (_a) {
            var timestamp = _a.timestamp, level = _a.level, message = _a.message, correlationId = _a.correlationId, meta = __rest(_a, ["timestamp", "level", "message", "correlationId"]);
            var metaStr = Object.keys(meta).length ? " ".concat(JSON.stringify(meta)) : '';
            var cid = correlationId ? " [".concat(correlationId, "]") : '';
            return "".concat(timestamp, " ").concat(level).concat(cid, ": ").concat(message).concat(metaStr);
        })),
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
if (env_1.env.LOG_TO_FILE) {
    transports.push(new winston_1.default.transports.DailyRotateFile({
        filename: 'app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        dirname: logDir,
        maxSize: '100m',
        maxFiles: '30d',
        format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    }));
}
exports.logger = winston_1.default.createLogger({
    level: env_1.env.LOG_LEVEL,
    transports: transports,
});
