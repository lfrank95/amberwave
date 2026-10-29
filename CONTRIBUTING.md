# Contributing to Amberwave

Thanks for wanting to help! Amberwave is in **public beta**. The most useful contributions right now:

- **Bug reports** with steps to reproduce (use the issue templates).
- **Feedback and ideas** in the subreddit (link in the README).
- **Translations** – the UI is German and English; the dictionary lives in `app/i18n/quelle/*.json`.
- **Pull requests** for bugs. For bigger features, please open an issue first so we can agree on the approach.

## Contributor License Agreement (CLA)

Amberwave is open core: the core is AGPL-3.0, and there may later be separately licensed "Pro" extensions. To keep that
possible, every pull request needs agreement to this short CLA. By opening a pull request you confirm:

1. **You wrote it** (or have the right to submit it), and it does not knowingly infringe anyone's rights.
2. **License to the project:** you grant the Amberwave maintainer a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license to use, modify, distribute and **sublicense** your contribution, including under licenses other
   than the AGPL (for example in commercial editions).
3. **Patent license:** you grant the same recipients a license to any patents you hold that your contribution
   necessarily infringes, for use with Amberwave.
4. **You keep your copyright.** Your contribution is also published under the AGPL-3.0 in this repository.

Add this line to your pull request description:

> I have read and agree to the Amberwave CLA in CONTRIBUTING.md.

*(This CLA is a plain-language draft modelled on the Apache Individual CLA. It is not legal advice; the maintainer
intends to have it reviewed.)*

## Development basics

- Server: PHP 8.3 + MariaDB, no framework. Front end: plain ES modules in `app/js`, bundled with `bash app/scripts/buendeln.sh` (needs [bun](https://bun.sh)).
- After changing translatable text: `python3 scripts/i18n_bauen.py` and `python3 scripts/i18n_pruefen.py` (in `app/`).
- Code and comments are mostly German. English issues and pull requests are welcome.
