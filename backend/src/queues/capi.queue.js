"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.capiQueue = void 0;
var bullmq_1 = require("bullmq");
var redis_1 = require("../config/redis");
exports.capiQueue = new bullmq_1.Queue('meta-capi', {
    connection: redis_1.redisBull,
    defaultJobOptions: {
        // 3 percobaan: backoff eksponensial 5s → 25s → 125s
        // Setelah 3 gagal, job masuk "failed" dan tidak mengganggu lead lain.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 100,
    },
});
