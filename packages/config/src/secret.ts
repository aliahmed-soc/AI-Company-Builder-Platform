// @acbp/config — Secret wrapper (ACBP-P0-015).
// Holds a server-only secret value and redacts it from every serialization path
// (string coercion, JSON.stringify, console/util.inspect) so it can never leak into
// logs, error messages, snapshots, or public config. The raw value is available only
// via reveal(), used at the point of use (e.g., the future Infisical bootstrap client).
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}
