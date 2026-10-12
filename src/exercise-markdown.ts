export interface ExerciseFile {
  fileName: string;
  content: string;
}

export interface ExerciseContent {
  title: string;
  instructionsHtml: string;
  learningObjective?: string | null;
  hintsHtml?: string[];
  files: ExerciseFile[];
  language?: string | null;
}

const languageAliases: Record<string, string> = {
  PYTHON: 'python', PYTHON3: 'python', PYTHON3_10: 'python',
  JAVASCRIPT: 'javascript', TYPESCRIPT: 'typescript', JAVA: 'java',
  C: 'c', CPP: 'cpp', CSHARP: 'csharp', GO: 'go', RUST: 'rust',
  RUBY: 'ruby', PHP: 'php', KOTLIN: 'kotlin', SWIFT: 'swift', SQL: 'sql'
};

function fenceLanguage(fileName: string, language?: string | null): string {
  const extension = fileName.split('.').pop()?.toLowerCase();
  const extensions: Record<string, string> = {
    py: 'python', js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    java: 'java', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', go: 'go',
    rs: 'rust', rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift',
    sql: 'sql', sh: 'bash', json: 'json', html: 'html', css: 'css', md: 'markdown'
  };
  return (extension && extensions[extension]) || (language && languageAliases[language.toUpperCase()]) || '';
}

export function exerciseToMarkdown(content: ExerciseContent, htmlToMarkdown: (html: string) => string): string {
  const parts = [`# ${content.title.trim()}`, '## Petunjuk', htmlToMarkdown(content.instructionsHtml).trim()];
  if (content.learningObjective?.trim()) {
    parts.push('## Tujuan latihan', content.learningObjective.trim());
  }
  const hints = (content.hintsHtml ?? []).map(htmlToMarkdown).map(value => value.trim()).filter(Boolean);
  if (hints.length) parts.push('## Hint', hints.map(value => `- ${value.replace(/\n+/g, '\n  ')}`).join('\n'));
  parts.push('## Starter files');
  if (!content.files.length) {
    parts.push('_Starter code tidak disediakan. Buat implementasi berdasarkan petunjuk di atas._');
  } else {
    for (const file of content.files) {
      const source = file.content.trimEnd() || '// TODO: implementasikan berdasarkan petunjuk latihan';
      parts.push(`### ${file.fileName}`, `\`\`\`${fenceLanguage(file.fileName, content.language)}\n${source}\n\`\`\``);
    }
  }
  return parts.filter(Boolean).join('\n\n').trimEnd() + '\n';
}
