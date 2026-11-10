/** Thrown for any invalid musical input (bad note name, impossible degree, …). */
export class MusicTheoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicTheoryError";
  }
}
