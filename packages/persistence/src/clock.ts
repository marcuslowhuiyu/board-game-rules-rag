export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (date: Date | string): Clock => ({
  now: () => (typeof date === 'string' ? new Date(date) : new Date(date.getTime())),
});
