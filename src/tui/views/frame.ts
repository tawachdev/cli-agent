// What a settings view needs from the screen it draws into. The Tui implements
// it; views only produce lines and react to keys.

export interface Frame {
  readonly rows: number;
  readonly usable: number;
  // width inside the main box, and inside a boxed panel within it, in cells
  innerWidth(): number;
  nestedWidth(): number;
  boxed(title: string, body: string[]): string[];
  refresh(): void;
  // hand the screen back to the prompt (the caller refreshes)
  closeView(): void;
}
