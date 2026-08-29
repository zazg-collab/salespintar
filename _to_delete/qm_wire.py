import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

def patch(relpath, pairs):
    path = os.path.join(ROOT, relpath)
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:200]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath}')


# ── app.ts ────────────────────────────────────────────────────────────────────
patch('backend/src/app.ts', [
(
"import chatImportRoutes from './routes/chat-import.routes';",
"import chatImportRoutes from './routes/chat-import.routes';\nimport questionMinerRoutes from './routes/question-miner.routes';"
),
(
"app.use(`${env.API_PREFIX}/chat-import`, chatImportRoutes);",
"app.use(`${env.API_PREFIX}/chat-import`, chatImportRoutes);\napp.use(`${env.API_PREFIX}/question-miner`, questionMinerRoutes);"
),
])

# ── queues/index.ts ───────────────────────────────────────────────────────────
patch('backend/src/queues/index.ts', [
(
"""export { shadowMiningQueue } from './shadow-mining.queue';""",
"""export { shadowMiningQueue } from './shadow-mining.queue';
export { questionMiningQueue } from './question-mining.queue';"""
),
(
"""  const { handleDebounceFlush } = await import('./debounce.worker');""",
"""  const { handleDebounceFlush } = await import('./debounce.worker');
  const { handleQuestionMining } = await import('./question-mining.worker');"""
),
(
"""  logger.info('BullMQ workers initialized (including Shadow Mining & Debounce)');""",
"""  // Question Miner: satu job = satu file chat. Concurrency 2 dan dibatasi laju
  // karena tiap job memanggil Groq sekali lalu menghitung embedding sebanyak
  // pertanyaan yang ditemukan — lebih ringan dari Shadow Mining, tapi tetap
  // tidak boleh membanjiri Groq saat ratusan file diunggah sekaligus.
  new Worker('question-mining', handleQuestionMining, {
    connection: redisBull,
    concurrency: 2,
    limiter: { max: 20, duration: 60000 },
  });

  logger.info('BullMQ workers initialized (including Shadow Mining, Question Miner & Debounce)');"""
),
(
"""  const { debounceQueue: dq } = await import('./debounce.queue');""",
"""  const { debounceQueue: dq } = await import('./debounce.queue');
  const { questionMiningQueue: qmq } = await import('./question-mining.queue');"""
),
(
"""  await smq.close();
  await dq.close();""",
"""  await smq.close();
  await dq.close();
  await qmq.close();"""
),
])

# ── frontend nav ──────────────────────────────────────────────────────────────
patch('frontend/src/app/app/layout.tsx', [
(
"  { href: '/app/auto-learning', label: 'Auto-Learning AI', icon: Brain },",
"  { href: '/app/auto-learning', label: 'Auto-Learning AI', icon: Brain },\n  { href: '/app/question-miner', label: 'Tambang Pertanyaan', icon: HelpCircle },"
),
])

# Import ikon HelpCircle di layout — sisipkan ke daftar import lucide yang ada.
layout = os.path.join(ROOT, 'frontend/src/app/app/layout.tsx')
src = io.open(layout, encoding='utf-8').read()
if 'HelpCircle' not in src.split("from 'lucide-react'")[0]:
    import re
    m = re.search(r"import\s*\{([^}]*)\}\s*from 'lucide-react';", src)
    assert m, 'blok import lucide-react tidak ketemu'
    inner = m.group(1)
    new_inner = inner.rstrip().rstrip(',') + ', HelpCircle'
    src = src[:m.start(1)] + new_inner + src[m.end(1):]
    io.open(layout, 'w', encoding='utf-8').write(src)
    print('OK   layout.tsx (import HelpCircle)')

print('SELESAI')
