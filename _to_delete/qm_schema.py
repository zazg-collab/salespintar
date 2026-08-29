import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

schema_path = os.path.join(ROOT, 'backend/prisma/schema.prisma')
src = io.open(schema_path, encoding='utf-8').read()

# ── 1. Relasi di Business ─────────────────────────────────────────────────────
old_rel = """  sessions      Session[]
  knowledge     Knowledge[]

  @@map("businesses")"""
new_rel = """  sessions      Session[]
  knowledge     Knowledge[]
  miningSessions MiningSession[]
  minedQuestions MinedQuestion[]

  @@map("businesses")"""
assert src.count(old_rel) == 1, 'relasi Business tidak unik'
src = src.replace(old_rel, new_rel)

# ── 2. Model baru ─────────────────────────────────────────────────────────────
models = '''

// ──────────────────────────────────────────────────────────────────────────────
// QUESTION MINER
//
// Berbeda tujuan dari Shadow Mining, dan perbedaannya disengaja:
//   Shadow Mining  → AI membaca percakapan dan MENULIS SENDIRI dokumennya.
//   Question Miner → AI hanya memungut PERTANYAAN pelanggan; jawaban CS DIBUANG,
//                    dan yang mengisi jawabannya adalah pemilik bisnis.
//
// Alasannya ada di catatan prinsip: jawaban CS dari chat lama bisa memuat harga
// dan kebijakan yang sudah berubah, sedangkan pertanyaan pelanggan tidak pernah
// basi — "berapa harga X" tetap relevan bertahun-tahun kemudian.
// ──────────────────────────────────────────────────────────────────────────────

model MiningSession {
  id          String   @id @default(uuid()) @db.Uuid
  businessId  String   @map("business_id") @db.Uuid
  /** Nama file zip yang diunggah, sekadar supaya Angga ingat ini sesi yang mana. */
  label       String   @db.VarChar(200)
  /** pending | running | done | failed */
  status      String   @default("pending") @db.VarChar(20)
  totalFiles     Int @default(0) @map("total_files")
  processedFiles Int @default(0) @map("processed_files")
  totalMessages  Int @default(0) @map("total_messages")
  /** Nama-nama yang ditandai Angga sebagai tim CS. */
  csNames     Json     @default("[]") @map("cs_names")
  errorMessage String? @map("error_message") @db.Text
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz()
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz()

  business  Business        @relation(fields: [businessId], references: [id], onDelete: Cascade)
  questions MinedQuestion[]

  @@index([businessId, createdAt])
  @@map("mining_sessions")
}

model MinedQuestion {
  id         String  @id @default(uuid()) @db.Uuid
  businessId String  @map("business_id") @db.Uuid
  sessionId  String  @map("session_id") @db.Uuid

  /** Bentuk baku pertanyaan, hasil perapian model. */
  question   String  @db.Text
  /** Kutipan asli pertama yang memicu pertanyaan ini — supaya Angga bisa menilai
   *  apakah pengelompokannya masuk akal, bukan cuma percaya pada hasil mesin. */
  sampleRaw  String  @map("sample_raw") @db.Text
  /** Berapa kali pertanyaan semakna ini muncul. Dasar pengurutan tabel. */
  occurrences Int    @default(1)

  /** Vektor untuk menggabungkan pertanyaan yang maknanya sama. Dimensinya sama
   *  dengan tabel Knowledge (384) karena memakai model embedding yang sama. */
  embedding  Unsupported("vector(384)")?

  /** Jawaban yang DITULIS ANGGA. Kosong = belum dijawab. Sengaja tidak pernah
   *  diisi otomatis dari chat — itulah inti seluruh fitur ini. */
  answer     String? @db.Text
  /** Produk | SOP | FAQ — tebakan awal dari model, bisa diubah Angga. */
  category   String  @default("FAQ") @db.VarChar(20)
  /** open | answered | dismissed | published */
  status     String  @default("open") @db.VarChar(20)
  /** Path relatif dokumen di vault, diisi setelah "Susun Dokumen". */
  vaultPath  String? @map("vault_path") @db.VarChar(500)

  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz()
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz()

  business Business      @relation(fields: [businessId], references: [id], onDelete: Cascade)
  session  MiningSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([businessId, status])
  @@index([sessionId])
  @@map("mined_questions")
}
'''

src = src.rstrip() + '\n' + models
io.open(schema_path, 'w', encoding='utf-8').write(src)
print('OK   schema.prisma')

# ── 3. Migration SQL ──────────────────────────────────────────────────────────
mig_dir = os.path.join(ROOT, 'backend/prisma/migrations/20260729_question_miner')
os.makedirs(mig_dir, exist_ok=True)
sql = '''-- Question Miner: tabel sesi penambangan + pertanyaan hasil tambang.
-- Catatan: kolom `embedding` memakai tipe vector(384) dari pgvector, dimensi yang
-- sama dengan tabel `knowledge` karena memakai model embedding yang sama.
-- Prisma tidak bisa membuat kolom bertipe Unsupported, jadi ditambahkan manual.

CREATE TABLE IF NOT EXISTS "mining_sessions" (
  "id"              UUID PRIMARY KEY,
  "business_id"     UUID NOT NULL,
  "label"           VARCHAR(200) NOT NULL,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'pending',
  "total_files"     INTEGER NOT NULL DEFAULT 0,
  "processed_files" INTEGER NOT NULL DEFAULT 0,
  "total_messages"  INTEGER NOT NULL DEFAULT 0,
  "cs_names"        JSONB NOT NULL DEFAULT '[]',
  "error_message"   TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "mining_sessions_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "mining_sessions_business_id_created_at_idx"
  ON "mining_sessions" ("business_id", "created_at");

CREATE TABLE IF NOT EXISTS "mined_questions" (
  "id"          UUID PRIMARY KEY,
  "business_id" UUID NOT NULL,
  "session_id"  UUID NOT NULL,
  "question"    TEXT NOT NULL,
  "sample_raw"  TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "embedding"   vector(384),
  "answer"      TEXT,
  "category"    VARCHAR(20) NOT NULL DEFAULT 'FAQ',
  "status"      VARCHAR(20) NOT NULL DEFAULT 'open',
  "vault_path"  VARCHAR(500),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "mined_questions_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
  CONSTRAINT "mined_questions_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "mining_sessions"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "mined_questions_business_id_status_idx"
  ON "mined_questions" ("business_id", "status");
CREATE INDEX IF NOT EXISTS "mined_questions_session_id_idx"
  ON "mined_questions" ("session_id");
'''
io.open(os.path.join(mig_dir, 'migration.sql'), 'w', encoding='utf-8').write(sql)
print('OK   migration.sql')
print('SELESAI')
