export interface PageSignals {
  urlPath: string;
  title: string;
  curriculumVisible: boolean;
  expectedLecture: boolean;
  visibleChallengeElement: boolean;
  shortChallengePage: boolean;
}

export interface PageDecision {
  state: 'ready' | 'blocked' | 'transient';
  evidence: string[];
}

export function decidePageHealth(signals: PageSignals): PageDecision {
  const evidence: string[] = [];
  if (signals.visibleChallengeElement) evidence.push('visible-challenge-element');
  if (/^\/(?:captcha|challenge|access-denied|blocked)(?:\/|$)/.test(signals.urlPath.toLowerCase())) evidence.push('challenge-path');
  if (/^(?:just a moment|verify you are human|security challenge|access denied)(?:[.! -]|$)/.test(signals.title.trim().toLowerCase())) evidence.push('challenge-title');
  if (!signals.curriculumVisible && signals.shortChallengePage) evidence.push('short-challenge-page');
  const blocked = signals.visibleChallengeElement || (!signals.curriculumVisible && evidence.length >= 2);
  return {
    state: blocked ? 'blocked' : signals.curriculumVisible && signals.expectedLecture ? 'ready' : 'transient',
    evidence
  };
}
