export class FreshMemoryError extends Error {
  constructor(message, code = "INVALID_ARGUMENT", options) {
    super(message, options);
    this.name = "FreshMemoryError";
    this.code = code;
  }
}
