/** Ephemeral UI state only. Durable data belongs to the future Personal Core. */
export function createInitialUIState(theme="light"){return {view:"chat",assistant:"main",theme,chatTheme:"Minimal",responseStyle:"Balanced",chat:[],labTab:"Overview",codeTab:"Editor",testCategory:"Coding",density:"Comfortable"};}
