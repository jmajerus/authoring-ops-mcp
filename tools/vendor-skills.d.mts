// Types for the tests, which import the script as it is.
export interface VendorOptions { ref?: string; worktree?: boolean; from?: string; out?: string; suite?: string }
export interface Vendored { repo: string; ref: string; commit: string; dirty?: boolean; skills: string[]; tools_used: boolean }
export function vendorSkills(options?: VendorOptions): Vendored | null;
