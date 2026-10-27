# M3 slice 4 — Candidate retrieval cases

_Companion to `2026-10-27-m3-retrieval-eval-design.md`. Research on 2026-10-27 from BGG rules forums. Questions are paraphrased. Each thread is `https://boardgamegeek.com/thread/<id>`._

**Columns:**
- **Evidence:** dev chunk number (old chunking, before M2-T1) followed by a key phrase. The builder re-checks every phrase against the fresh eval ingest.
- **RB:** whether the rulebook alone answers it (yes / part / no).
- **Status:** **keep**, **drop** (the reason is given), or **faq**. **faq** means the case becomes complete once the official FAQ is ingested.

## SETI (24)

| # | Tier | Question | Thread | Evidence | RB | Status |
|---|---|---|---|---|---|---|
| S1 | complex | With 5 moves from a card and 4 used, can I take a free action and then spend the last move? | 3621540 | 0093 "For each you use, move one of your probes"; 0083 "Free actions can be performed at any time during your turn" | part | drop: movement banking is disputed |
| S2 | simple | Is a completed sector resolved right after the main action or at end of turn? | 3459324 | 0099 "When you finish your main action, resolve all of the sectors" | yes | keep |
| S3 | complex | After scanning, refill the card row before or after resolving completed sectors? | 3597279 | 0097 "Refill the card row afterward"; 0099 "When you finish your main action…"; FAQ "refill the card row after finishing the Scan action" | part | faq |
| S4 | complex | When a played card includes a Scan, do sectors resolve after the scan part or the whole card? | 3604127 | 0105 "you perform the action without paying its standard cost"; 0099 "When you finish your main action…" | part | keep: community-only on the inference, so the builder confirms the evidence suffices or drops it |
| S5 | simple | Must a card's icons be resolved left to right? | 3386154 | FAQ (designer): evaluated left to right | no | faq |
| S6 | simple | Can a mission trigger or be completed on another player's turn? | 3482154 | 0107 "It is possible to trigger some missions even outside of your turn"; 0107 "At any time during your turn, if the condition is met" | yes | keep |
| S7 | complex | If rotation pushes my probe into asteroids or a comet on another turn, do I gain publicity, and is it a "visit"? | 3445454 | 0112 "the probe's owner gains that publicity immediately"; 0113 "When you move to asteroids, gain 1 publicity"; 0198 "To move a probe onto the space with the planet" | part | faq: card FAQ #129 |
| S8 | complex | Can one action trigger rewards on two different missions at once? | 3641166 | 0107 "only a single space can be covered at a time"; FAQ one space per effect | part | faq |
| S9 | complex | 2 players: when someone hits 20 points, do both neutral markers move? | 3386868 | 0122 "move a nonplayer marker from the milestone to the leftmost empty space"; FAQ "you place only one" | part | faq |
| S10 | complex | Where does a neutral marker go: leftmost overall, or one per alien? | 3632508 | 0122 "the leftmost empty space"; FAQ fill the left species first | part | faq |
| S11 | complex | My scan wins a sector for an opponent and we both pass gold milestones. Who picks first, and when? | 3689819 | 0099 "That player places a marker… and gets the reward"; 0120 "At the end of a turn in which you reach or pass 25, 50, or 70"; 0126 "starting with the player whose turn has just ended" | yes | keep |
| S12 | complex | One turn crosses a gold and a neutral milestone and a species is discovered. What order? | 3632508 | 0119 "resolved between turns, after the current player has finished"; 0126 "it is always resolved last"; 0130 "resolve them before resolving the discovery" | yes | keep: the operator's headline case |
| S13 | simple | Does the first to pass in round 5 still rotate the solar system? | 3453249 | 0128 "In round 5, you still rotate, but discard the token" | yes | keep |
| S14 | simple | A card shows rotate and tech icons. Rotate once or twice? | 3416169 | 0108 "The card reminds you to rotate the solar system too"; 0109 "You always rotate the solar system when you research a tech" | yes | keep |
| S15 | simple | Must probe or telescope techs be researched in numbered order? | 3427337 | 0108 "Then you choose one of the techs you don't have yet" | yes | keep |
| S16 | complex | A new computer tech goes under an existing data token. Do I get the bonus and the 2 points? | 3394849 | 0108 "you will not score for the 2-point space your data token is now covering"; 0112 "Each tech has a bonus printed on it. Gain this bonus immediately." | yes | keep |
| S17 | simple | Can I skip a lower computer-tech space and fill it later? | 3499706 | 0117 "they can be filled in at any point provided that the space above" | yes | keep |
| S18 | simple | If my first orbiter is removed, does the 3 VP space reopen? | 3382683 | FAQ card #15 (rulebook author): it reopens, no sliding | no | faq |
| S19 | simple | Is there a hand limit, and when? | 3371487 | 0128 "Discard down to 4 cards if you have more than 4"; "no limit in number of cards you can have in your hand" | yes | keep |
| S20 | simple | Can I skip a scan signal to avoid completing a sector for an opponent? | 3786446 | 0099 "You may never choose to skip placing a signal"; 0097 "You always mark at least 2 signals" | yes | keep |
| S21 | simple | Can a life trace go on an overflow space while a normal space is free? | 3594782 | 0136 "even if another space on an alien board is already available" | yes | keep |
| S22 | simple | Do discovery-space and overflow markers count as traces on a species? | 3416169 | 0136 "all markers in the overflow space count, as do any markers on the discovery spaces" | yes | keep |
| S23 | simple | Can several probes share a space, including Earth? | 3432328 | — | no | drop: community-only |
| S24 | complex | Can a card drawn from a mission mid-scan be discarded for the telescope tech in the same scan? | 3450040 | 0083 free actions; 0107 "Only things you do after playing the mission can trigger it"; 0113 "discard one card from your hand to mark an extra signal" | part | drop: community-only |
| S25 | simple | Who gets the small vs large sector reward? | 3422907 | 0099 "lesser rewards to players who win them later" | yes | keep: spare |

## Ticket to Ride (15)

| # | Tier | Question | Thread | Evidence | RB | Status |
|---|---|---|---|---|---|---|
| T1 | simple | After a blind draw, can my second card be a face-up locomotive? | 21706 | 0005 "the player who draws it may only draw one card, instead of two" | part | keep: Days of Wonder ruling is M6 future evidence |
| T2 | simple | Can one player claim both tracks of a double route? | 1111586 | 0006 "One player cannot claim both routes to the same cities." | yes | keep |
| T3 | complex | 2–3 players: does the one-track rule cover coloured double routes, and what cards pay for grey? | 1181463 | 0006 "In 2 or 3 player games, only one of the Double-Routes can be used."; 0005 "Gray colored – can be claimed using a set of cards of any one color" | yes | keep |
| T4 | simple | Can I claim a coloured route with only locomotives? | 1722748 | 0005 "act as a wild card that can be part of any set of cards" | part | keep |
| T5 | simple | Can I claim a 3-space route with only 2 trains left? | 3044862 | 0005 "placing one of his colored trains on each space of this route" | part | keep |
| T6 | complex | Does the end trigger count cards or plastic trains, who gets a last turn, and can I claim on it? | 3456177 | 0007 "stock of colored plastic trains gets down to only 0,1 or 2"; 0007 "each player, including that player, gets one final turn"; 0001 "must perform one (and only one) of the following three actions" | yes | keep |
| T7 | simple | After finishing my tickets, must I draw more? | 809373 | 0007 "A player can use his turn to draw more Destination Ticket cards." | yes | keep |
| T8 | simple | When drawing tickets, can I discard ones I already held? | 338748 | 0007 "draws 3 new cards… He must keep at least one" | part | keep |
| T9 | complex | Do unfinished tickets cost points, and how is the final score totalled? | 2701581 | 0007 "they deduct the amount"; 0007 "adds 10 points to his score"; 0007 route scoring table | yes | keep |
| T10 | simple | How is the longest path measured: branches, loops, reused cities? | 426572 | 0007 "only take into account continuous lines"; "may include loops… a given plastic train may never be used twice" | part | keep |
| T11 | complex | Tied on points and tickets with no longest-path card. Who wins? Do tied longest paths all score 10? | 21131 | 0007 "the player who has completed the most Destination Tickets wins"; "the player with the Longest Continuous Path card wins"; "all tied players score the 10 point bonus" | part | keep |
| T12 | complex | The deck empties while a third face-up locomotive appears. Wipe or reshuffle first? | 1510834 | 0005 three locomotives rule; 0005 deck exhausted rule | part | drop: disputed |
| T13 | complex | Only locomotives left. How do we stop endless wipes? | 3534903 | 0005 three locomotives rule; 0005 no cards left rule | part | drop: answer is a 2025 Days of Wonder forum ruling, which is M6 |
| T14 | simple | Can I claim Kansas City–Omaha–Duluth in one turn? | 775809 | 0006 "A player may only claim a maximum of one route" | yes | keep |
| T15 | simple | Must opponents reveal how many cards they hold? | 364771 | — | no | drop: not in the rules |
| T16 | simple | Is there a hand limit? | 1849678 | 0005 "A player may have any number of cards in his hand at any time." | yes | keep: spare |

## Wingspan (17)

_None of these threads could be opened (403), so each question's gist comes from a search snippet. The evidence is from rulepop chunks, which is solid._

| # | Tier | Question | Thread | Evidence | RB | Status |
|---|---|---|---|---|---|---|
| W1 | simple | Can the 2-food-for-1 swap pay a bird power's discard cost? | 2772249 | 0164 "This exchange cannot be used during other parts of the game." | yes | keep |
| W2 | simple | Can I do the 2-for-1 swap several times for one bird? | 2401739 | 0164 "you may spend any 2 food tokens as if they are any 1 food token" | part | keep |
| W3 | simple | Does a star nest count as a ground/bowl nest for goals? | 2128771 | 0162 "Star nests are wild"; 0017 "Star nests count toward this goal." | yes | keep |
| W4 | simple | Does "white & no powers" count birds with "when played" powers? | 2842747 | 0047 "either no power, or a "when played" power" | yes | keep |
| W5 | simple | One die left in the feeder. Can I reroll all five? | 3059153 | 0122 "all show the same face (including if there is only 1 die)" | yes | keep |
| W6 | simple | Can cached food pay for a new bird? | 2563867 | 0164 "not food tokens cached on bird cards"; 0124 "You cannot spend that food token" | yes | keep |
| W7 | simple | My predator's card has too large a wingspan. What happens to it? | 3448645 | 0171 "If they find one, they keep it"; appendix: discarded | part | faq: appendix PDF |
| W8 | simple | Can pink powers trigger on my own turn, and how often? | 2131563 | 0119 "only use a pink power once between each of your own turns" | yes | keep |
| W9 | simple | After my last turn, can my pink power still trigger? | 2691061 | 0132 "your pink power can activate once after your last turn" | yes | keep |
| W10 | simple | Green goal side: how are points split on a tie for first? | — | 0175 "add the points for that place and the next place(s), then divide… round down" | yes | keep: no BGG thread; source it to the rules |
| W11 | complex | Can a "repeat a brown power" bird copy one to its right, and whose card gets the result? | 2261564 | 0133 "can be to the left or to the right"; 0118 "activated from right to left"; Stonemaier FAQ: targets the original bird | part | faq |
| W12 | complex | Does a teal round-end power resolve before goal scoring, and in what order? | 2505467 | 0120 "before scoring the goal for that round"; "Resolve them in player order, starting with the first player"; 0005 round structure | yes | keep |
| W13 | complex | Does an opponent's round-end or game-end tuck trigger my pink Vulture? | 2171210 | 0120 "Round end powers do NOT activate 'once between turns' (pink) powers."; 0121 "do not trigger birds with pink" | yes | keep |
| W14 | complex | What counts as a predator "succeeding" for the Vultures? | 2171210 | 0171 "If they find one, they keep it, and it counts"; 0178 tucked cards; Stonemaier FAQ: must actually tuck or cache | part | faq |
| W15 | complex | A pink power gives me feeder food. May I reroll matching dice, and is the dual face "seed"? | 3005003 | 0122 "about to gain food for any reason… throw all 5 dice"; "counts as its own unique face"; 0133 "Regular reroll rules apply" | yes | keep |
| W16 | complex | An opponent's brown power gives everyone food. Does my "when another player gains food" pink fire? | 2769217 | 0119 "may be triggered on opponents' turns"; 0118 brown | part | drop: no official ruling, and the card text is not ingested |
| W17 | complex | "Play a second bird, pay its normal cost": egg cost too, and does its white power fire? | 2145993 | 0164 column egg costs; 0163 "If you cannot afford to pay the full cost"; 0117 when played | part | faq: appendix PDF |
| W18 | complex | Tied on points: does cached food count as "unused food"? | 2260122 | 0069 "the player with the most unused food tokens wins"; 0124 "You cannot spend that food token; instead, it's worth 1 VP" | part | keep |

## Tally

"Keep" includes the spare questions S25 and T16.

| Game | Keep | FAQ | Drop |
|---|---|---|---|
| SETI | 15 (+S4 pending a check) | 7 | 3 |
| Ticket to Ride | 12 | 0 | 3 |
| Wingspan | 12 | 5 | 1 |
| **Total** | **~39–40** | **12** | **7** |

Ingesting the FAQs makes about 51 usable. Trim to about 45, keeping about one third complex.
