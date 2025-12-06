/**
 * Random word filename generator for agent output files
 */

const ADJECTIVES = [
  'azure', 'bright', 'calm', 'dancing', 'eager', 'fierce', 'gentle', 'hidden',
  'ivory', 'jade', 'keen', 'lively', 'misty', 'noble', 'olive', 'proud',
  'quiet', 'rapid', 'serene', 'tender', 'unique', 'vivid', 'warm', 'young',
  'amber', 'bold', 'cosmic', 'dawn', 'ember', 'frosty', 'golden', 'humble',
  'iron', 'jolly', 'kind', 'lunar', 'mellow', 'nimble', 'ocean', 'peaceful',
  'quaint', 'rustic', 'solar', 'twilight', 'urban', 'velvet', 'wild', 'zealous',
  'ancient', 'blazing', 'crystal', 'daring', 'endless', 'flowing', 'glowing', 'hollow',
  'icy', 'joyful', 'knowing', 'lasting', 'mighty', 'narrow', 'open', 'pure',
  'quick', 'rising', 'silver', 'true', 'upper', 'vast', 'winding', 'young',
  'agile', 'breezy', 'clever', 'dusty', 'early', 'fresh', 'grand', 'hasty',
  'inner', 'jumpy', 'lucky', 'magic', 'north', 'outer', 'plain', 'royal',
  'sandy', 'thick', 'ultra', 'vital', 'wavy', 'zero', 'sweet', 'stark',
];

const NOUNS = [
  'anchor', 'beacon', 'canyon', 'delta', 'echo', 'falcon', 'glacier', 'harbor',
  'island', 'jewel', 'kernel', 'lantern', 'meadow', 'nectar', 'oasis', 'pebble',
  'quartz', 'river', 'summit', 'temple', 'unity', 'valley', 'willow', 'zenith',
  'arrow', 'bridge', 'cloud', 'dune', 'ember', 'forest', 'garden', 'haven',
  'inlet', 'jungle', 'knight', 'lotus', 'mirror', 'nest', 'orbit', 'prism',
  'quest', 'reef', 'spark', 'trail', 'umbra', 'vortex', 'wave', 'yarn',
  'acorn', 'brook', 'coral', 'dream', 'edge', 'flame', 'grove', 'haze',
  'iris', 'jade', 'kite', 'leaf', 'moon', 'nova', 'owl', 'peak',
  'raven', 'stone', 'torch', 'urn', 'vine', 'wind', 'fox', 'bear',
  'crane', 'dove', 'elk', 'fern', 'goose', 'hawk', 'ibis', 'jay',
  'lark', 'moth', 'newt', 'otter', 'pine', 'robin', 'swan', 'tiger',
  'wolf', 'wren', 'bass', 'crow', 'deer', 'finch', 'gull', 'heron',
];

/**
 * Get a random element from an array
 */
function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random filename in the format: adjective-noun-noun.md
 * Example: sunny-singing-crayon.md
 */
export function generateRandomFilename(): string {
  const adj = randomElement(ADJECTIVES);
  const noun1 = randomElement(NOUNS);
  let noun2 = randomElement(NOUNS);

  // Ensure noun2 is different from noun1
  while (noun2 === noun1) {
    noun2 = randomElement(NOUNS);
  }

  return `${adj}-${noun1}-${noun2}.md`;
}
