export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  sink?: (line: string) => void;
  now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const base: LogFields = options.base ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());

  const write = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    const record = {
      level: recordLevel,
      time: now().toISOString(),
      msg: message,
      ...base,
      ...(fields ?? {}),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (bindings) =>
      createLogger({
        level,
        base: { ...base, ...bindings },
        sink,
        now,
      }),
  };
}
