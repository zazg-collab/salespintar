'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertOctagon, MessageCircleQuestion, Send } from 'lucide-react';
import { apiGet, apiPost } from '../../../../../../lib/api';

interface ViolationDetail {
  id: string;
  channel: string;
  timestamp_start?: string | null;
  timestamp_end?: string | null;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  critical_code?: string | null;
  detected_element: string;
  policy_reference: string;
  remediation: string;
}

interface ClarificationQuestion {
  violation_id: string;
  target_timestamp?: string | null;
  question: string;
}

interface ComplianceAuditReport {
  audit_id: string;
  verdict: string;
  overall_compliance_score: number;
  raw_assessment: {
    violations: ViolationDetail[];
    clarification_questions: ClarificationQuestion[];
  };
}

type AuditStatusResponse =
  | { status: 'queued' | 'processing' }
  | { status: 'done'; report: ComplianceAuditReport }
  | { status: 'error'; error: string };

const RISK_STYLE: Record<string, string> = {
  HIGH: 'bg-rose-100 text-rose-700 border-rose-200',
  MEDIUM: 'bg-amber-100 text-amber-700 border-amber-200',
  LOW: 'bg-gray-100 text-gray-600 border-gray-200',
};

export default function ComplianceAnalysisPage() {
  const params = useParams<{ auditId: string }>();
  const auditId = params.auditId;
  const [report, setReport] = useState<ComplianceAuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<AuditStatusResponse>(`/video-guard/audit/${auditId}`)
      .then((res) => {
        if (res.status === 'done') setReport(res.report);
        else if (res.status === 'error') setError(res.error);
        else setError('Audit belum selesai diproses — kembali ke halaman laporan untuk menunggu.');
      })
      .catch((e) => setError((e as Error).message || 'Gagal memuat analisis.'));
  }, [auditId]);

  async function handleClarify(violationId: string) {
    const userContext = (answers[violationId] || '').trim();
    if (!userContext) return;
    setSending(violationId);
    setSendError(null);
    try {
      const updated = await apiPost<ComplianceAuditReport>(`/video-guard/audit/${auditId}/clarify`, {
        violation_id: violationId,
        user_context: userContext,
      });
      setReport(updated);
      setAnswers((prev) => ({ ...prev, [violationId]: '' }));
    } catch (e) {
      setSendError((e as Error).message || 'Gagal mengirim klarifikasi.');
    } finally {
      setSending(null);
    }
  }

  const openQuestions = report?.raw_assessment.clarification_questions ?? [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link href={`/app/video-guard/audit/${auditId}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Laporan
      </Link>

      <h1 className="text-lg md:text-xl font-bold text-gray-900">Analisis Kepatuhan Rinci</h1>

      {error && <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-xl px-4 py-3 text-sm">{error}</div>}
      {sendError && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{sendError}</div>}

      {!report && !error && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Memuat…
        </div>
      )}

      {report && (
        <div className="space-y-4">
          {report.raw_assessment.violations.map((v) => {
            const question = openQuestions.find((q) => q.violation_id === v.id);
            return (
              <div key={v.id} className="bg-white rounded-2xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <AlertOctagon className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-gray-900">{v.detected_element}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Channel: {v.channel}
                        {v.timestamp_start ? ` · ${v.timestamp_start}${v.timestamp_end ? ` – ${v.timestamp_end}` : ''}` : ''}
                      </p>
                    </div>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full border ${RISK_STYLE[v.risk_level]}`}>
                    {v.risk_level}
                  </span>
                </div>

                <div className="mt-3 text-sm text-gray-600 space-y-1">
                  <p><span className="font-medium text-gray-700">Kebijakan:</span> {v.policy_reference}</p>
                  <p><span className="font-medium text-gray-700">Saran perbaikan:</span> {v.remediation}</p>
                </div>

                {question && (
                  <div className="mt-4 bg-indigo-50 border border-indigo-200 rounded-xl p-4">
                    <p className="text-sm font-medium text-indigo-900 flex items-start gap-2">
                      <MessageCircleQuestion className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      {question.question}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <input
                        type="text"
                        value={answers[v.id] || ''}
                        onChange={(e) => setAnswers((prev) => ({ ...prev, [v.id]: e.target.value }))}
                        placeholder="Jelaskan konteksnya di sini…"
                        className="flex-1 border border-indigo-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
                      />
                      <button
                        onClick={() => handleClarify(v.id)}
                        disabled={sending === v.id || !(answers[v.id] || '').trim()}
                        className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                      >
                        {sending === v.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        Kirim
                      </button>
                    </div>
                    <p className="text-[11px] text-indigo-500 mt-2">
                      AI akan mengecek ulang klaim ini terhadap piksel/audio asli video (bukan cuma teks jawaban Anda).
                    </p>
                  </div>
                )}
              </div>
            );
          })}

          {report.raw_assessment.violations.length === 0 && (
            <p className="text-sm text-gray-500">Tidak ada pelanggaran terdeteksi pada audit ini.</p>
          )}
        </div>
      )}
    </div>
  );
}
