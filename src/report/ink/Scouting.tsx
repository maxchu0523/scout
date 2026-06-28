import { Box, Text } from "ink";
import { useEffect, useState } from "react";

const TRACK = 22;

/**
 * A little scouting party marching left → right across a dotted road, one
 * soldier after another. Cosmetic; shown only while a scan is in progress.
 */
export function Scouting({
  caption,
  ascii,
}: {
  readonly caption: string;
  readonly ascii: boolean;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, []);

  const soldier = ascii ? ">" : "🪖";
  const road = ascii ? "-" : "·";

  // Three soldiers in a column, staggered, marching off the right edge and
  // looping back from the left.
  const head = tick % (TRACK + 6);
  const positions = new Set([head, head - 3, head - 6]);

  const cells: string[] = [];
  for (let i = 0; i < TRACK; i++) {
    cells.push(positions.has(i) ? soldier : road);
  }

  return (
    <Box>
      <Text color="yellow">Scouting </Text>
      <Text color="green">{cells.join("")}</Text>
      <Text color="gray"> {caption}</Text>
    </Box>
  );
}
