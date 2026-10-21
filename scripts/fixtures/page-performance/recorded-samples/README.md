<!-- markdownlint-disable-file MD041 -->

# Recorded page samples

Three Lighthouse reports from one CI job, for `http://localhost:3300/payouts`, collected from a build whose bytes were proved identical to the branch it was compared against. They are the samples recorded as the evidence on #311, which is where #342 came from.

Six numbers in these files are a measurement. Everything else is scaffolding.

| Sample       | `categories.performance.score` | `total-blocking-time.numericValue` |
| ------------ | ------------------------------ | ---------------------------------- |
| `lhr-1.json` | 0.79                           | 512.5 ms                           |
| `lhr-2.json` | 0.75                           | 651.2 ms                           |
| `lhr-3.json` | 0.91                           | 136.5 ms                           |

The spread of 0.16 between the first and third is wider than the 0.11 between the failing median, 0.79, and the 0.9 bar those runs were judged against. That is the whole argument for reporting those two metrics rather than failing on them: the instrument moved further on identical bytes than the distance it was being asked to measure.

`lighthouseVersion` names the release the pinned toolchain installs, and the suite asserts it against the installed package. Nothing in the replay reads that field, which is the reason to pin it: a change to the report shape fails loudly on its own, while a version move would leave these files working and quietly no longer representative. A bump now has to be noticed, and whoever makes it has to decide whether the recorded spread still describes the runner. The audits carry no display strings, because a rendered string that nothing reads is one more claim to keep true.

Every other field is the least a Lighthouse report needs for the remaining assertions to be evaluated at all, set to passing values so a replay isolates the two metrics under test: accessibility and best practices at 1, layout shift at 0, and a round fetch time. None of those four is a reading of anything. Each file repeats this in a `_fixtureNote` key, because JSON cannot carry a comment and one of these files may well be met alone, through a search or copied into another test.

## What reads them

- `scripts/replay-page-samples.sh` replays all three through the real `lhci assert` in both directions: the committed config must not fail them, and the same samples with the two reported bars set back to `error` must fail. CI runs it before the page measurement.
- `scripts/page-performance.test.ts` asserts the six numbers above, the median and the spread, so a fixture cannot be edited into a different measurement without the suite failing.

File names have to match `lhr-<digits>.json`, which is the only shape `lhci` reads; it ignores anything else in a report folder without a word.
