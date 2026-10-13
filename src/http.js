export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

export const placeholders = (arr) => arr.map(() => '?').join(',');
