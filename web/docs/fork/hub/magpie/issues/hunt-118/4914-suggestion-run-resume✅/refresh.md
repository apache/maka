Rebased onto today's main (): the shelve guard it touches gained an  short-circuit upstream (#2432's one-off asks), so the two changes are merged — the suggestion-answered run still keeps its session for the conversation's next turn ( falls through), while one-off asks keep their short-circuit. New head, same single commit; directed tests re-run green on the rebased tree ( family ), gofmt/vet clean.

- head:  (was )
- patch SHA-256 first 16: 992461411e05e016
- branch: [fix/4914-suggestion-run-resume](https://github.com/ggbdpq/magpie/tree/fix/4914-suggestion-run-resume) — force-with-lease pushed
