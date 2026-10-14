export interface Frame {
  readonly rows: number;
  readonly usable: number;
  innerWidth(): number;
  nestedWidth(): number;
  boxed(title: string, body: string[]): string[];
  refresh(): void;
  closeView(): void;
}
