
export function nativeStringChoice(raw: string, choices: string[]): string | null {
    if (!choices.length || /[^\x00-\x7f]/.test(raw) || choices.some(choice => !choice || /[^\x00-\x7f]/.test(choice))) return null;
    const value = raw.trim().toUpperCase();
    let selected = choices[0], longest = 0;
    for (const choice of choices) {
        if (choice.length > longest && value.startsWith(choice.toUpperCase())) {
            selected = choice;
            longest = choice.length;
        }
    }
    return selected;
}
