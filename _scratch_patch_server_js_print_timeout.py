import sys

PATH = "/root/salespintar-ai-agent/api-bridge/server.js"

# Fix (2026-08-26): agy CLI punya timeout internal SENDIRI untuk print mode (--print-timeout,
# default 5m0s dari `agy --help`) yang TIDAK PERNAH kita override. Akibatnya, agy nyerah sendiri
# di ~5 menit (log internalnya: "Print mode: timed out after ~1300 polls") walau subagent masih
# aktif kerja (masih dapat step baru, tool call masih di-approve) dan walau timeout EKSTERNAL kita
# sendiri (effectiveTimeoutMs/AGY_TIMEOUT_MS, sampai 10-15 menit utk video-guard) belum lewat sama
# sekali. Teks error internal itu ("...agy exited with code 1") lolos balik sbg kalau itu jawaban
# valid, gagal parse JSON di metaguard_service, jatuh ke "Perlu Review Manual" skor 0 -- padahal
# videonya sendiri sebenarnya masih bisa dianalisis kalau dikasih waktu cukup.
#
# Konfirmasi lewat log internal agy sendiri (/root/.gemini/antigravity-cli/log/cli-*.log), pola
# "Print mode: timed out after N polls" sudah muncul berulang sejak 25 Agustus -- BUKAN kejadian
# baru, BUKAN gara-gara perubahan Copywriting Ads (pool `video-guard` yang kena, bukan
# `copywriting-ads`, dan sudah kejadian jauh sebelum fix Copywriting Ads di-deploy hari ini).
#
# Fix: kirim --print-timeout ke `agy` di KEDUA titik spawn (/v1/run dan /v1/global-run), nilainya
# disamakan dgn timeout EKSTERNAL yang sudah kita hitung/pakai sendiri (effectiveTimeoutMs /
# AGY_TIMEOUT_MS) -- supaya agy tidak lagi diam-diam nyerah lebih cepat dari yang kita kira sudah
# kita kasih.

OLD_RUN = """  const startedAt = Date.now();
  const args = ['--dangerously-skip-permissions', '--add-dir', AGY_WORKDIR, '-p', prompt];"""

NEW_RUN = """  const startedAt = Date.now();
  // [2026-08-26] --print-timeout: agy CLI punya timeout print-mode INTERNAL sendiri (default
  // 5m0s, lihat `agy --help`) yang independen dari timeout eksternal kita (effectiveTimeoutMs di
  // atas) -- tanpa flag ini, agy diam-diam nyerah di ~5 menit walau subagent masih aktif kerja dan
  // walau timeout eksternal kita jauh lebih longgar (sampai 15 menit). Root cause kegagalan
  // berulang "agy exited with code 1"/"Perlu Review Manual" di Video Guard (lihat ledger
  // anti-drift, entri 2026-08-26). Format Go duration -- pakai satuan detik ("Ns").
  const args = ['--dangerously-skip-permissions', '--add-dir', AGY_WORKDIR, '-p', prompt, '--print-timeout', `${Math.ceil(effectiveTimeoutMs / 1000)}s`];"""

OLD_GLOBAL = """  const args = ['--dangerously-skip-permissions', '--add-dir', AGY_WORKDIR, '-p', fullPrompt, '--output-format', 'stream-json'];"""

NEW_GLOBAL = """  // [2026-08-26] --print-timeout: lihat komentar sama persis di handler /v1/run di atas -- agy
  // CLI punya timeout print-mode internal sendiri (default 5m0s) yang independen dari
  // AGY_TIMEOUT_MS eksternal kita. Disamakan di sini juga demi konsistensi (endpoint ini dipakai
  // GlobalAgentWidget chat, bukan Video Guard, tapi resiko/mekanismenya identik).
  const args = ['--dangerously-skip-permissions', '--add-dir', AGY_WORKDIR, '-p', fullPrompt, '--output-format', 'stream-json', '--print-timeout', `${Math.ceil(AGY_TIMEOUT_MS / 1000)}s`];"""


def patch_one(content, old, new, label):
    count = content.count(old)
    if count != 1:
        print(f"ABORT: block '{label}' found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)
    return content.replace(old, new)


def main():
    with open(PATH, "r", encoding="utf-8") as f:
        content = f.read()

    content = patch_one(content, OLD_RUN, NEW_RUN, "/v1/run args")
    content = patch_one(content, OLD_GLOBAL, NEW_GLOBAL, "/v1/global-run args")

    with open(PATH, "w", encoding="utf-8") as f:
        f.write(content)

    print("PATCHED_OK")


if __name__ == "__main__":
    main()
