async (page) => {
  const quizId = new URL(page.url()).pathname.match(/\/quiz\/(\d+)/)?.[1];
  if (!quizId) return { content: null, availability: 'retryable', reason: 'Halaman Latihan Coding belum aktif.' };
  await page.locator('[data-purpose="instructions-content"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return page.evaluate(async (id) => {
    const endpoint = `/api-2.0/quizzes/${id}/assessments/?version=1&page_size=250&fields[assessment]=id,assessment_type,prompt,related_lectures`;
    try {
      const response = await fetch(endpoint, { credentials: 'include' });
      if (!response.ok) return { content: null, availability: 'retryable', reason: `Data Latihan Coding gagal dimuat (HTTP ${response.status}).` };
      const body = await response.json();
      const prompt = body.results?.find(item => item.assessment_type === 'coding-problem')?.prompt;
      if (!prompt) return { content: null, availability: 'unavailable', reason: 'Petunjuk Latihan Coding tidak tersedia.' };
      const title = document.querySelector('[data-purpose="exercise-title"]')?.textContent?.trim()
        || document.querySelector('[data-purpose="instructions-content"] h1, [data-purpose="instructions-content"] h2')?.textContent?.trim()
        || `Latihan Coding ${id}`;
      // Deliberately whitelist only learner-facing prompts and initial files.
      // solution, solution_files, test_files, and correct_response never leave the page.
      return {
        content: {
          title,
          instructionsHtml: prompt.instructions || document.querySelector('[data-purpose="instructions-content"]')?.innerHTML || '',
          learningObjective: prompt.learning_objective || null,
          hintsHtml: Array.isArray(prompt.hints) ? prompt.hints.map(hint => hint.description).filter(Boolean) : [],
          files: Array.isArray(prompt.initial_files)
            ? prompt.initial_files.map(file => ({ fileName: file.file_name || 'starter.txt', content: file.content || '' }))
            : [],
          language: prompt.language || null
        },
        availability: 'available',
        reason: null
      };
    } catch (error) {
      return { content: null, availability: 'retryable', reason: `Data Latihan Coding belum siap: ${String(error)}` };
    }
  }, quizId);
}
