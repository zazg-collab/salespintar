import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

export const metadata: Metadata = {
  title: 'SalesPintar — AI Customer Service WhatsApp',
  description: 'Balas chat pelanggan otomatis 24/7 dengan AI, takeover oleh sales kapan saja, dan kirim broadcast terjadwal.',
};

import { Toaster } from 'react-hot-toast';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <Providers>
          {children}
          <Toaster position="top-right" />
        </Providers>
      </body>
    </html>
  );
}
