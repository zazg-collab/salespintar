import sys

PATH = "/opt/salespintar/frontend/src/app/app/video-guard/copywriting-ads/page.tsx"

OLD_IMPORTS = """import React, { useState } from 'react';
import {
  PenSquare,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  ShieldAlert,
  Sparkles,
  Quote,
} from 'lucide-react';
import { apiPost } from '../../../../lib/api';"""

NEW_IMPORTS = """import React, { useState } from 'react';
import Link from 'next/link';
import {
  PenSquare,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  ShieldAlert,
  Sparkles,
  Quote,
  Settings,
} from 'lucide-react';
import { apiPost } from '../../../../lib/api';"""

OLD_HEADER = """      <div>
        <h1 className="text-lg md:text-xl font-bold text-gray-900 flex items-center gap-2">
          <PenSquare className="w-5 h-5 text-fuchsia-600" />
          Copywriting Ads
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          Cek copy iklan terhadap kebijakan Meta/TikTok &amp; risiko regulasi Indonesia, atau bikin
          variasi copy baru dari keyword/produk.
        </p>
      </div>"""

NEW_HEADER = """      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-bold text-gray-900 flex items-center gap-2">
            <PenSquare className="w-5 h-5 text-fuchsia-600" />
            Copywriting Ads
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Cek copy iklan terhadap kebijakan Meta/TikTok &amp; risiko regulasi Indonesia, atau bikin
            variasi copy baru dari keyword/produk.
          </p>
        </div>
        <Link
          href="/app/video-guard/copywriting-ads/pengaturan"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-fuchsia-700 border border-gray-200 hover:border-fuchsia-300 rounded-lg px-3 py-2 transition-colors shrink-0"
        >
          <Settings className="w-3.5 h-3.5" /> Pengaturan Provider LLM
        </Link>
      </div>"""


def patch_one(content, old, new, label):
    count = content.count(old)
    if count != 1:
        print(f"ABORT: block '{label}' found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)
    return content.replace(old, new)


def main():
    with open(PATH, "r", encoding="utf-8") as f:
        content = f.read()

    content = patch_one(content, OLD_IMPORTS, NEW_IMPORTS, "imports")
    content = patch_one(content, OLD_HEADER, NEW_HEADER, "header")

    with open(PATH, "w", encoding="utf-8") as f:
        f.write(content)

    print("PATCHED_OK")


if __name__ == "__main__":
    main()
