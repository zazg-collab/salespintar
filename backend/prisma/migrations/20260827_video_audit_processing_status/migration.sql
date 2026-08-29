-- [2026-08-27] fix kolom "Status Audit" terpisah dari "Status AI" (feedback Bossfren) -- lihat
-- catatan lengkap di schema.prisma model VideoAdAudit / video-guard.routes.ts persistAuditReport().
ALTER TABLE video_ad_audits ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) DEFAULT 'SUCCESS';

-- Backfill baris yang sudah ada berdasarkan kondisi verdict saat migrasi ini dijalankan.
UPDATE video_ad_audits SET processing_status = 'PROCESSING' WHERE verdict IS NULL AND processing_status IS NULL;
UPDATE video_ad_audits SET processing_status = 'TECHNICAL_ERROR' WHERE verdict = 'MANUAL_REVIEW' AND processing_status IS NULL;
UPDATE video_ad_audits SET processing_status = 'SUCCESS' WHERE processing_status IS NULL;
