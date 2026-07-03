import { Box, Text } from "ink";
import type React from "react";

/**
 * Interactive /sdd interview overlay: presents the model's clarifying questions one
 * at a time, echoing already-answered ones and previewing the rest. The answer typed
 * so far is passed in as `current`; Enter advances, Esc skips the remaining questions.
 * Mirrors the LoginOverlay interaction model.
 */
export function SddInterview({
  questions,
  answers,
  current,
}: {
  questions: string[];
  /** Answers collected so far; its length is the current question index. */
  answers: string[];
  /** The answer being typed for the current question. */
  current: string;
}): React.ReactElement {
  const idx = Math.min(answers.length, questions.length - 1);
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
    >
      <Text color="magenta" bold>
        {`▸ /sdd interview — question ${answers.length + 1}/${questions.length}`}
      </Text>
      {questions.map((q, i) => {
        if (i < answers.length) {
          const a = answers[i]?.trim();
          return (
            <Text key={q} color="gray" dimColor wrap="truncate-end">
              {`  ✓ ${q} → ${a || "(skipped)"}`}
            </Text>
          );
        }
        if (i === idx) {
          return (
            <Box key={q} flexDirection="column">
              <Text color="white">{`  ? ${q}`}</Text>
              <Box>
                <Text color="magenta">{"    › "}</Text>
                <Text>{current}</Text>
                <Text color="magenta">▎</Text>
              </Box>
            </Box>
          );
        }
        return (
          <Text key={q} color="gray" dimColor wrap="truncate-end">
            {`  · ${q}`}
          </Text>
        );
      })}
      <Text color="gray" dimColor>
        {"  Enter next · Esc skip the rest (spec proceeds with what you gave)"}
      </Text>
    </Box>
  );
}
