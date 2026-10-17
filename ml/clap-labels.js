// Zero-shot label set for CLAP. Each Barkoff animal gets two prompts: the
// real animal and a person imitating it (players are people, so the second
// one matters most). Distractors absorb probability mass for sounds that are
// clearly not the target, so a clip can't win by being "least unlike" it.
export const CLAP_LABELS = [
  { animal: 'dog', kind: 'real', text: 'a dog barking' },
  { animal: 'dog', kind: 'imitation', text: 'a person imitating a dog barking' },
  { animal: 'wolf', kind: 'real', text: 'a wolf howling' },
  { animal: 'wolf', kind: 'imitation', text: 'a person imitating a wolf howling' },
  { animal: 'cat', kind: 'real', text: 'a cat meowing' },
  { animal: 'cat', kind: 'imitation', text: 'a person imitating a cat meowing' },
  { animal: 'cow', kind: 'real', text: 'a cow mooing' },
  { animal: 'cow', kind: 'imitation', text: 'a person imitating a cow mooing' },
  { animal: 'lion', kind: 'real', text: 'a lion roaring' },
  { animal: 'lion', kind: 'imitation', text: 'a person imitating a lion roaring' },
  { animal: 'rooster', kind: 'real', text: 'a rooster crowing' },
  { animal: 'rooster', kind: 'imitation', text: 'a person imitating a rooster crowing' },
  { animal: 'duck', kind: 'real', text: 'a duck quacking' },
  { animal: 'duck', kind: 'imitation', text: 'a person imitating a duck quacking' },
  { animal: null, kind: 'distractor', text: 'a person speaking' },
  { animal: null, kind: 'distractor', text: 'a person singing' },
  { animal: null, kind: 'distractor', text: 'a person laughing' },
  { animal: null, kind: 'distractor', text: 'silence' },
  { animal: null, kind: 'distractor', text: 'background noise' },
  { animal: null, kind: 'distractor', text: 'music' },
  { animal: null, kind: 'distractor', text: 'electronic beeping' },
  { animal: null, kind: 'distractor', text: 'a pig oinking' },
];
