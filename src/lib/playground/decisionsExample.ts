/** Shared by the normal API editor and Decisions shortcut; model comes from the selector. */
export const DECISIONS_EXAMPLE = {
  model: "",
  input: "Build a React Native note-taking app with login.",
  questions: [
    { type: "predicate", name: "software", instructions: "Does this ask to build software?" },
    {
      type: "choice",
      name: "category",
      instructions: "Choose the task category.",
      choices: [
        { value: "coding", description: "Building or debugging software" },
        { value: "general", description: "Other everyday questions" },
      ],
    },
    {
      type: "score",
      name: "complexity",
      instructions: "Rate the task complexity.",
      levels: [
        { label: "simple", description: "A single basic operation" },
        { label: "multi_step", description: "Several connected implementation steps" },
      ],
    },
  ],
};

/** Selection changes only the model, never the user's input, questions or cache options. */
export function replaceDecisionModel(body: string, model: string): string {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value))
      return JSON.stringify({ ...value, model }, null, 2);
  } catch {
    /* Keep incomplete JSON editable; submission explains the parse error. */
  }
  return body.trim() ? body : JSON.stringify({ ...DECISIONS_EXAMPLE, model }, null, 2);
}
