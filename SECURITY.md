# Security Policy

This research project is maintained on a best-effort basis by a small team at
Lab271, Schuberg Philis.

## Maturity

Before you deploy it anywhere that matters:

- There has been no independent security review of this codebase.
- Much of it is written by AI agents under human review. The review is real, but
  it is not the same thing as an audit.
- Breaking changes can and will happen. This is a labs experiment.

None of that means we are relaxed about security reports. It means you should
calibrate your trust accordingly, and that we would rather hear about a problem
than not.

## Reporting a vulnerability

Please report privately. Do not open a public GitHub issue, and do not discuss the
vulnerability publicly until a fix is available.

**Preferred:** email [abuse@schubergphilis.com](mailto:abuse@schubergphilis.com),
naming this repository in the subject. This is Schuberg Philis's standing
responsible-disclosure channel. Encrypted mail is preferred; the PGP public key is
at <https://keybase.io/schubergphilis>. The company's full responsible disclosure
policy - including credit, the hall of fame, and the bounty - is at
<https://schubergphilis.com/security>, and takes precedence over this document on
anything it covers.

**On GitHub:** private vulnerability reporting should be enabled on this repository - use
the ["Report a vulnerability" button](../../security/advisories/new) under the
Security tab.

Please don't send sensitive information over unencrypted channels or social media.

Please include:

- What the issue is, and what an attacker gets out of it.
- Steps to reproduce, or a proof of concept.
- The version and platform you saw it on.
- Any workaround you have already found.
- Whether you want public credit or prefer to stay anonymous.

Do not include real customer data, live credentials, or content from a private
system in a report. A redacted reproduction is more useful to us than a real one.

## Rules of engagement

If you think you have found a vulnerability, we would appreciate it if you:

- Don't exploit your finding.
- Share the information with just us, not other parties.
- Give us time to assess the situation and respond.

## What to expect

1. We aim to acknowledge your report within 5 business days.
2. We aim to confirm or close it, with a written explanation either way, within
   15 business days.
3. For confirmed issues, we will agree a fix and disclosure timeline with you.
4. We will credit you in the release notes and the advisory if you have told us
   you want public credit. By default you stay anonymous.

These are targets, not contractual commitments, and they apply to this open source
project. Reports about Schuberg Philis production systems fall under
<https://schubergphilis.com/security> instead.

## Scope

In scope: the code in this repository, and documentation that would lead a careful
operator into an insecure configuration.

Out of scope:

- Services and APIs this project talks to. Report those to the vendor.
- External tools and third-party dependencies. Report upstream - but do tell
  us if the way this project *calls* a dependency turns a non-issue into an
  exploitable one, or if we are pinning something known-vulnerable.
- Operator misconfiguration, such as an over-broad API token or a
  world-readable config file.
- Findings from a scanner with no demonstrated impact here.

## Good faith

If you follow this policy in good faith, we will treat your report as a
contribution: we will work through it with you, we will tell you what we decided
and why, and we will not ask you to stay quiet indefinitely. In return, please
don't access, modify, or retain data that isn't yours, and don't degrade any
service while investigating.
