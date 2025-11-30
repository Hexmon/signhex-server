export interface HttpStatusInfo {
  code: number;
  text: string;
  description: string;
}

export type HttpStatusCode = HttpStatusInfo['code'];

const httpStatusList = [
  {
    code: 100,
    text: 'Continue',
    description: 'Request headers received; client can continue sending the body.',
  },
  {
    code: 101,
    text: 'Switching Protocols',
    description: 'Server is switching protocols as requested by the client.',
  },
  {
    code: 102,
    text: 'Processing',
    description: 'Request accepted; processing is continuing (WebDAV).',
  },
  {
    code: 103,
    text: 'Early Hints',
    description: 'Preliminary response with headers so the client can start preloading resources.',
  },
  {
    code: 200,
    text: 'OK',
    description: 'Request succeeded.',
  },
  {
    code: 201,
    text: 'Created',
    description: 'Request succeeded and a new resource was created.',
  },
  {
    code: 202,
    text: 'Accepted',
    description: 'Request accepted for processing, but not yet completed.',
  },
  {
    code: 203,
    text: 'Non-Authoritative Information',
    description: 'Request succeeded; response metadata may come from a transforming proxy.',
  },
  {
    code: 204,
    text: 'No Content',
    description: 'Request succeeded; no response body.',
  },
  {
    code: 205,
    text: 'Reset Content',
    description: 'Request succeeded; client should reset the document view.',
  },
  {
    code: 206,
    text: 'Partial Content',
    description: 'Partial response to a range request.',
  },
  {
    code: 207,
    text: 'Multi-Status',
    description: 'Multiple status codes for different operations in a single response (WebDAV).',
  },
  {
    code: 208,
    text: 'Already Reported',
    description: 'Members of a WebDAV collection were already returned in a previous response.',
  },
  {
    code: 226,
    text: 'IM Used',
    description: 'Request succeeded; response is the result of instance manipulations.',
  },
  {
    code: 300,
    text: 'Multiple Choices',
    description: 'Multiple representations are available; client can choose one.',
  },
  {
    code: 301,
    text: 'Moved Permanently',
    description: 'Resource moved permanently to a new URI.',
  },
  {
    code: 302,
    text: 'Found',
    description: 'Resource temporarily resides under a different URI.',
  },
  {
    code: 303,
    text: 'See Other',
    description: 'Client should retrieve the resource at another URI using GET.',
  },
  {
    code: 304,
    text: 'Not Modified',
    description: 'Resource has not changed; use cached version.',
  },
  {
    code: 307,
    text: 'Temporary Redirect',
    description: 'Resource temporarily resides at another URI; keep the same HTTP method.',
  },
  {
    code: 308,
    text: 'Permanent Redirect',
    description: 'Resource permanently resides at another URI; keep the same HTTP method.',
  },
  {
    code: 400,
    text: 'Bad Request',
    description: 'Request is invalid or malformed.',
  },
  {
    code: 401,
    text: 'Unauthorized',
    description: 'Authentication is required or has failed.',
  },
  {
    code: 402,
    text: 'Payment Required',
    description: 'Reserved for future use; sometimes used for payment-related APIs.',
  },
  {
    code: 403,
    text: 'Forbidden',
    description: 'Request understood but explicitly refused.',
  },
  {
    code: 404,
    text: 'Not Found',
    description: 'Requested resource could not be found.',
  },
  {
    code: 405,
    text: 'Method Not Allowed',
    description: 'HTTP method is not allowed for the target resource.',
  },
  {
    code: 406,
    text: 'Not Acceptable',
    description: 'No response format matches the Accept headers.',
  },
  {
    code: 407,
    text: 'Proxy Authentication Required',
    description: 'Client must authenticate with a proxy server first.',
  },
  {
    code: 408,
    text: 'Request Timeout',
    description: 'Server timed out waiting for the request.',
  },
  {
    code: 409,
    text: 'Conflict',
    description: 'Request conflicts with the current state of the resource.',
  },
  {
    code: 410,
    text: 'Gone',
    description: 'Resource is permanently removed and no longer available.',
  },
  {
    code: 411,
    text: 'Length Required',
    description: 'Content-Length header is required.',
  },
  {
    code: 412,
    text: 'Precondition Failed',
    description: 'One or more request preconditions were not met.',
  },
  {
    code: 413,
    text: 'Content Too Large',
    description: 'Payload exceeds the server limits.',
  },
  {
    code: 414,
    text: 'URI Too Long',
    description: 'Request URI is too long to process.',
  },
  {
    code: 415,
    text: 'Unsupported Media Type',
    description: 'Payload media type is not supported.',
  },
  {
    code: 416,
    text: 'Range Not Satisfiable',
    description: 'Requested range cannot be fulfilled for the resource.',
  },
  {
    code: 417,
    text: 'Expectation Failed',
    description: 'Cannot meet the requirements of the Expect header.',
  },
  {
    code: 421,
    text: 'Misdirected Request',
    description: 'Request was sent to a server that cannot respond for the target.',
  },
  {
    code: 422,
    text: 'Unprocessable Content',
    description: 'Request is syntactically correct but semantically invalid.',
  },
  {
    code: 423,
    text: 'Locked',
    description: 'Resource is locked (WebDAV).',
  },
  {
    code: 424,
    text: 'Failed Dependency',
    description: 'Request failed because a dependency failed (WebDAV).',
  },
  {
    code: 425,
    text: 'Too Early',
    description: 'Server is unwilling to risk processing a replayable request.',
  },
  {
    code: 426,
    text: 'Upgrade Required',
    description: 'Client must switch to a different protocol.',
  },
  {
    code: 428,
    text: 'Precondition Required',
    description: 'Request must be conditional to prevent conflicts.',
  },
  {
    code: 429,
    text: 'Too Many Requests',
    description: 'Rate limit exceeded.',
  },
  {
    code: 431,
    text: 'Request Header Fields Too Large',
    description: 'Headers are too large; reduce size and retry.',
  },
  {
    code: 451,
    text: 'Unavailable For Legal Reasons',
    description: 'Resource is unavailable due to legal demands.',
  },
  {
    code: 500,
    text: 'Internal Server Error',
    description: 'Generic server error.',
  },
  {
    code: 501,
    text: 'Not Implemented',
    description: 'Server does not support the requested functionality.',
  },
  {
    code: 502,
    text: 'Bad Gateway',
    description: 'Invalid response from an upstream server.',
  },
  {
    code: 503,
    text: 'Service Unavailable',
    description: 'Server is temporarily unable to handle the request.',
  },
  {
    code: 504,
    text: 'Gateway Timeout',
    description: 'Upstream server failed to respond in time.',
  },
  {
    code: 505,
    text: 'HTTP Version Not Supported',
    description: 'HTTP version used in the request is not supported.',
  },
  {
    code: 506,
    text: 'Variant Also Negotiates',
    description: 'Configuration error: transparent content negotiation resulted in a cycle.',
  },
  {
    code: 507,
    text: 'Insufficient Storage',
    description: 'Server is unable to store the representation to complete the request (WebDAV).',
  },
  {
    code: 508,
    text: 'Loop Detected',
    description: 'Server detected an infinite loop while processing a request (WebDAV).',
  },
  {
    code: 510,
    text: 'Not Extended',
    description: 'Further extensions are required for the request to be fulfilled.',
  },
  {
    code: 511,
    text: 'Network Authentication Required',
    description: 'Client must authenticate to gain network access (e.g., captive portal).',
  },
] as const satisfies readonly HttpStatusInfo[];

export const HTTP_STATUS_CODES: readonly HttpStatusInfo[] = httpStatusList;

export const HTTP_STATUS_BY_CODE: Readonly<Record<HttpStatusCode, HttpStatusInfo>> = Object.freeze(
  httpStatusList.reduce((acc, status) => {
    acc[status.code] = status;
    return acc;
  }, {} as Record<HttpStatusCode, HttpStatusInfo>)
);

const statusNameEntries = httpStatusList.map((status) => [
  status.text.replace(/'/g, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase(),
  status.code,
]);

export const HTTP_STATUS: Readonly<Record<string, HttpStatusCode>> = Object.freeze(
  Object.fromEntries(statusNameEntries) as Record<string, HttpStatusCode>
);

export function getStatusInfo(code: number): HttpStatusInfo | undefined {
  return HTTP_STATUS_BY_CODE[code as HttpStatusCode];
}

export function isInformational(code: number): boolean {
  return code >= 100 && code < 200;
}

export function isSuccess(code: number): boolean {
  return code >= 200 && code < 300;
}

export function isRedirection(code: number): boolean {
  return code >= 300 && code < 400;
}

export function isClientError(code: number): boolean {
  return code >= 400 && code < 500;
}

export function isServerError(code: number): boolean {
  return code >= 500 && code < 600;
}
