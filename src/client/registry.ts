/** Screens register themselves here; the shell draws whichever one the route names. */
export const VIEWS: Record<string, () => string> = {};
export const VT: Record<string, (v: any, sm: any) => string> = {};
