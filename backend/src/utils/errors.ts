export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(404, `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}

export class UnauthorizedError extends AppError {
  /**
   * `rutin` menandai kegagalan yang MEMANG DIHARAPKAN terjadi berkala dan sudah
   * ditangani klien sendiri — sekarang cuma satu: access token kedaluwarsa.
   *
   * Kenapa perlu: `errorHandler` mencatat SEMUA AppError di level `warn`. Dengan
   * masa hidup token 15 menit, dashboard yang dibuka seharian menghasilkan satu
   * baris `warn: 401 Invalid or expired token` tiap 15 menit — 28 baris dalam
   * 7,5 jam pada 30 Juli, dan Angga wajar mengiranya kerusakan.
   *
   * Yang lebih berbahaya: token KEDALUWARSA (rutin, tiap 15 menit) dan token
   * TIDAK SAH (tanda tangan salah — bisa berarti seseorang mengarang token)
   * menghasilkan pesan dan level log yang SAMA PERSIS. Jadi percobaan pemalsuan
   * token akan tenggelam di antara puluhan baris rutin, tidak bisa dibedakan.
   * Peringatan yang selalu menyala sama saja dengan tidak ada peringatan.
   */
  constructor(message: string = 'Unauthorized', code?: string, public rutin: boolean = false) {
    super(401, message, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(403, message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}
