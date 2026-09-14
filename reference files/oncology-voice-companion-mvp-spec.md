# MVP Spec v2: The Caregiver Voice Companion for Oncology — Built on ElevenLabs Agents

## 1. What the MVP Is (and Isn't)

**One-sentence product:** A proactive voice companion for the *caregiver* of a person with cancer — it calls them, answers them 24/7, trains them for the medical tasks nobody trained them for, watches *their* burden as closely as the patient's symptoms, walks the family through the legal paperwork (power of attorney, advance directives) that nobody does until it's too late, and stays with them through the transition to palliative care, hospice, and bereavement.

**Why caregiver-first is the sharper wedge:**

- **The scale is enormous and underserved.** 63 million Americans — nearly 1 in 4 adults — provided ongoing care in the past year, up ~45% since 2015 ([AARP/NAC](https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html)). Over 40% provide high-intensity care, many performing complex medical tasks like injections and equipment management, **yet only 22% receive any training** ([Caregiving in the US 2025](https://www.aarp.org/pri/topics/ltss/family-caregiving/caregiving-in-the-us-2025/)).
- **Cancer caregivers are in measurable crisis.** Pooled prevalence of depressive symptoms is ~42% and anxiety ~46% among caregivers of patients in active treatment ([NCI PDQ](https://www.cancer.gov/about-cancer/coping/family-friends/family-caregivers-hp-pdq)). NCI's caregiver profile: 72% assist with medical tasks, 50% report high emotional stress, **40% want help making end-of-life decisions**, and only about half were ever asked what help *they* needed after discharge ([NCI PDQ](https://www.cancer.gov/about-cancer/coping/family-friends/family-caregivers-hp-pdq)).
- **The caregiver is the D2C buyer.** The patient is often too sick to onboard a product; the adult child or spouse is the one searching at 2 a.m., paying for tools, and coordinating siblings. Caregiver-first means your user, buyer, and champion are the same person.
- **The patient still benefits — through the caregiver.** Collateral symptom reporting ("Mom's been more short of breath since yesterday") is how a huge share of real escalation signal actually reaches care teams. The agent captures it at the source.

**Deliberately out of scope for MVP:** medical diagnosis or treatment advice, legal *advice* (education and navigation only — see Section 5), EHR integration, billing, clinician-facing documentation. The agent informs, organizes, coaches, screens, and escalates — it never practices medicine or law.

**The MVP must prove four numbers:**

1. **Caregiver engagement** — weekly check-in completion sustained 12+ weeks (the app-decay bar: ~75% → ~50% by months 7–9).
2. **Caregiver burden detection** — validated burden screening (Zarit-style) delivered conversationally, with trend detection and human referral.
3. **Safety** — 100% recall on red-flag symptom scenarios *reported second-hand by a caregiver* (harder than patient self-report: vaguer, more anxious, more hedged).
4. **Advance-care-planning completion lift** — % of onboarded families who complete a healthcare PoA/advance directive within 90 days, vs. the ~1-in-3 national baseline ([Health Affairs](https://pubmed.ncbi.nlm.nih.gov/28679811/)).

---

## 2. Architecture: What the Agent Sits On

Same core principle as before: **ElevenLabs is the conversation layer; your backend is the product.** The difference in v2 is that the central data object is not a patient — it's a **care dyad plus an authority graph**: the patient, one or more caregivers, and the legal/clinical authority relationships between them.

```
┌────────────────────────────────────────────────────────────────────┐
│  CHANNELS                                                          │
│  Caregiver phone (PSTN via Twilio) ─┐  Web app (React SDK widget)  │
│  Patient phone (secondary channel) ─┤  SMS/email summaries         │
│                                     ▼                              │
│                      ┌─────────────────────────┐                   │
│                      │   ELEVENLABS AGENT      │                   │
│                      │  Scribe ASR → Claude/   │                   │
│                      │  Gemini LLM → Flash TTS │                   │
│                      │  + turn-taking + RAG KB │                   │
│                      │  + Workflow graph       │                   │
│                      └──┬───────────────┬──────┘                   │
│            webhook tools│               │ post-call webhook        │
│                         ▼               ▼                          │
│  ┌───────────────────────────────────────────────────────┐         │
│  │  YOUR BACKEND                                         │         │
│  │  • Dyad context service (patient profile, treatment   │         │
│  │    calendar, last check-ins, care phase)              │         │
│  │  • AUTHORITY GRAPH (who is caregiver, who holds       │         │
│  │    healthcare PoA/proxy, HIPAA authorizations,        │         │
│  │    escalation rights per topic)                       │         │
│  │  • Deterministic red-flag rules engine                │         │
│  │  • Caregiver burden tracker (ZBI-style scores)        │         │
│  │  • Legal task engine (PoA/AD/POLST checklists, state- │         │
│  │    specific steps, referral dispatch)                 │         │
│  │  • Care-phase state machine (active tx → palliative   │         │
│  │    → hospice → bereavement)                           │         │
│  │  • Alert dispatcher + partner referral API            │         │
│  └──────┬──────────────┬──────────────┬──────────────────┘         │
│       ▼              ▼              ▼                              │
│  Nurse line /    Legal partners   Hospice agency /                 │
│  988 crisis line (Triage Cancer,  bereavement services             │
│                  CLRC, elder law)                                    │
└────────────────────────────────────────────────────────────────────┘
```

### The care-phase state machine (the product's spine)

The agent's behavior is governed by where the dyad sits in the illness trajectory. This is what makes it an *oncology* product rather than a generic voice bot:

| Phase | Trigger | Agent behavior changes |
|---|---|---|
| **Active treatment** | Onboarding default | Treatment-cycle check-ins, symptom red flags (fever/neutropenia), med schedule support, caregiver training modules, legal task nudges (PoA while patient has capacity) |
| **Advanced / palliative** | Clinician flag or caregiver report of disease progression | Goals-of-care conversation *guides* (educational, never directive), palliative care education (Temel evidence: early palliative care improved QoL, cut depression 16% vs 38%, and extended median survival 11.6 vs 8.9 months in metastatic NSCLC ([NEJM](https://www.nejm.org/doi/full/10.1056/NEJMoa1000678))), hospice-eligibility education, POLST conversation prep |
| **Hospice** | Hospice enrollment confirmed | Hospice-model orientation (what the agency covers, the 24/7 nurse line as first call), comfort-care coaching (pain, dyspnea, secretions, agitation), respite-care awareness, "what to expect" active-dying education, imminent-death call scripts routed to hospice nurse |
| **Bereavement** | Patient death (confirmed via caregiver or partner hospice) | Grief check-in cadence, complicated-grief screening, practical-task support (estate, death certificates, notifications), connection to hospice bereavement services — which Medicare requires hospices to offer families for **13 months** post-death ([CMS CoPs](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418)) |

Each phase shift changes the KB folders in scope, the rules engine's thresholds, the escalation targets, and the persona's pacing and register. Phase transitions are human-confirmed (caregiver attestation or partner data), never AI-inferred.

---

## 3. The Conversations the MVP Ships

### 3.1 The Caregiver Check-In (outbound, scheduled) — the core loop

Weekly (or post-treatment-cycle) outbound call to the caregiver, built as an ElevenLabs Workflow graph:

1. **Greeting & identity node** — verifies which caregiver is speaking against the authority graph (name + relationship + PIN/voice enrollment), discloses AI identity warmly, confirms it's an okay moment. `skip_turn` patience throughout.
2. **"How are *you* doing?" node** — the product's signature move. A short conversational burden screen (adapted Zarit domains: strain, sleep, own health, isolation, finances) asked *before* patient questions. Scores written via webhook tool to your burden tracker; a rising 3-call trend triggers a human-support referral offer (social worker, caregiver support group, respite resources).
3. **Collateral patient-symptom node** — "How has your mom been since Tuesday's treatment?" Conversational capture of the red-flag domains: fever, breathing, pain, confusion, bleeding, eating/drinking, falls, medication adherence. *The LLM collects; your deterministic rules engine scores* via the `evaluate_symptoms` webhook.
4. **Coaching node (RAG)** — the caregiver's questions answered from your curated KB: "How do I get her to eat when nothing tastes right?", "What do I do about the mouth sores?", "How do I safely help him shower?" This is the training 78% of caregivers never got.
5. **Red-flag gate (deterministic tool node)** — rules fire (fever ≥100.4°F, new confusion, uncontrolled pain despite meds, breathlessness at rest, fall with head strike on blood thinners, caregiver statements of crisis) → escalation node. Second-hand reports are scored *conservatively*: ambiguity escalates.
6. **Escalation node** — speaks the safety script, warm-transfers via `transfer_to_number` to the appropriate line (oncology triage, hospice nurse, or 911 instruction for emergencies), with `agent_message` carrying a structured SBAR-style summary. Caregiver expressions of self-harm or hopelessness → 988 crisis line protocol, per emerging AI-companion safety laws.
7. **Close node** — recaps actions, confirms next check-in, offers an SMS summary. Post-call webhook writes structured data (burden score, symptoms, questions for the care team, legal-task progress) to your DB.

### 3.2 The 24/7 Caregiver Line (inbound)

The 2 a.m. call: "Dad's breathing sounds wet and rattly — is this it?" Four subagents behind a router, with tools and KB scoped per node so boundaries are architectural, not prompt-based:

- **Care coach subagent** — hands-on caregiving guidance from the KB (positioning for breathlessness, mouth care, safe transfers, medication organization).
- **Patient-status subagent** — on-demand symptom capture with the same rules-engine gate.
- **Legal & paperwork subagent** — see Section 5.
- **End-of-life support subagent** — only active when the dyad is in hospice phase; see Section 6.

### 3.3 The Family Huddle (multi-caregiver coordination)

The 29% sandwich-generation reality: care is distributed across siblings and geographies. The agent runs structured *family update* calls or summaries — one caregiver's check-in produces an opt-in digest for the rest of the care circle ("Mom completed her week 6 check-in; nausea improving; the PoA documents are ready to sign"). The authority graph governs who hears what: clinical detail only to HIPAA-authorized members; logistics-only to helpers.

---

## 4. The Authority Graph: PoA as Product Infrastructure

This is the feature no horizontal voice vendor has, and it serves two functions at once — a **compliance primitive** and a **care-completion engine**.

### 4.1 Authority as data model

Every caller maps to a node in a per-dyad graph: `role` (patient / spouse / adult child / friend / paid aide), `hipaa_authorized` (bool + document ref), `healthcare_proxy` (bool + document ref + activation status), `financial_poa` (bool), `escalation_rights` (can receive clinical detail? can authorize escalation decisions?), `state` (jurisdiction governs document requirements). The agent's disclosure behavior, information sharing, and escalation routing all key off this graph. An unauthorized caller gets logistics and empathy, never clinical detail.

### 4.2 PoA/advance-directive completion as a guided workflow

The completion gap is the opportunity: only ~36.7% of U.S. adults have any advance directive (29.3% a living will) ([Health Affairs](https://pubmed.ncbi.nlm.nih.gov/28679811/)), and among metastatic cancer patients AD completion has hovered near 35% for 30 years ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC9983130/)). The agent runs a state-specific, multi-session completion flow:

1. **Educate** (KB/RAG): what a healthcare PoA/proxy does, how it differs from a living will and a financial PoA, why capacity matters ("these documents can only be signed while your mom can still make her own decisions — that's why we do it now").
2. **Decide**: conversation guides (not advice) to help the family identify the right proxy, surface values questions to discuss with the patient, and prepare for the clinician conversation. Caregivers' involvement in EOL decisions reaches up to 78% of cases — the agent meets that reality ([BMC Palliative Care](https://link.springer.com/article/10.1186/s12904-023-01327-w)).
3. **Execute**: state-specific document checklists, notarization/witness requirements by jurisdiction, links to free forms (state bar, CaringInfo-style resources), reminders across check-in calls, and referral to legal partners (Section 5) when the situation exceeds DIY (blended families, estranged relatives, assets).
4. **Verify & store**: document capture (photo upload in the web app), storage in the authority graph, and a "who to notify" checklist (oncologist, hospital, pharmacy).

**Hard boundary:** the agent educates and navigates; it never interprets a document, never opines on legal effect, never drafts bespoke instruments. Every session ends with the disclaimer and a referral path to a licensed attorney. This keeps you on the right side of unauthorized-practice-of-law rules.

---

## 5. The Legal Connection: Triage and Referral, Not Lawyering

Cancer creates a predictable cluster of legal needs: health insurance disputes and appeals, employment rights (ADA/FMLA), disability benefits (SSDI — many cancers qualify for Compassionate Allowances), estate planning, medical debt, and the PoA/advance-directive set above. A national support infrastructure already exists but is badly under-discovered: **Triage Cancer's Legal & Financial Navigation Program** offers free one-on-one help with insurance, disability, employment, finances, medical decision-making, and estate planning ([Triage Cancer](https://triagecancer.org/legal-and-financial-navigation-program)); the **Cancer Legal Resource Center** runs a free national telephone assistance line (866-843-2572) ([CancerCare](https://www.cancercare.org/publications/331-legal_assistance__finding_resources_and_support)); CancerCare's LegalHealth clinic covers NYC residents.

**MVP implementation:**

- **KB-driven legal literacy** — plain-language explainers per topic, sourced and reviewed, in the RAG layer.
- **A legal-needs screen** woven into check-ins (not interrogation): "A lot of families we support run into insurance or work issues — is anything like that on your plate?" Flags route to the legal task engine.
- **`refer_legal_partner` webhook tool** — structured referral dispatch to partner organizations (topic, state, language, urgency, callback window). For the MVP this can be as simple as warm handoff instructions + SMS with the right phone number and a prepared script for what to ask.
- **Business development angle:** these nonprofits want reach; a voice channel that routes *qualified, prepared* callers to them is a partnership, not a competitor. Later monetization: elder-law attorney network referral fees (carefully disclosed), or sponsored access via employers/insurers.

---

## 6. The Hospice & End-of-Life Connection

This is where caregiver-first becomes most differentiated — and most sensitive. The design rule: **the agent supports the caregiver through dying; it never manages the dying.**

### 6.1 Pre-hospice: the palliative bridge

Late hospice referral is a national failure mode — in Temel's trial, standard-care patients had a median hospice stay of just **4 days** ([NEJM](https://www.nejm.org/doi/full/10.1056/NEJMoa1000678)). Caregivers are often the last to understand what hospice is and the ones carrying the decision conversation. The agent's job here is purely educational and preparatory:

- Explain palliative care vs. hospice vs. curative treatment, and the counterintuitive evidence that earlier palliative involvement improved both QoL *and* survival.
- Explain Medicare hospice eligibility factually: two physicians certify a prognosis of 6 months or less if the illness runs its normal course; the patient signs an election statement; benefit periods are two 90-day periods then unlimited 60-day periods; DNR is **not** required for admission; revocation is allowed anytime ([CMS](https://www.cms.gov/medicare/payment/fee-for-service-providers/hospice), [Medicare Advocacy](https://medicareadvocacy.org/medicare-info/medicare-hospice-benefit/)).
- Coach the caregiver to raise goals-of-care questions with the oncology team — supplying the *questions*, never the answers.
- **Never prognosticate.** Any "how long does she have?" gets a scripted acknowledgment + routing to the care team. This is a hard guardrail with an end_call-and-escalate action.

### 6.2 On hospice: the 24/7 gap filler — and a B2B channel

Medicare-certified hospices must make nursing services available 24/7 ([42 CFR §418.100](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418)), and their after-hours phone lines are staffed by exhausted on-call nurses fielding caregiver panic calls — comfort-kit medication questions, "is this normal" dying-process questions, and true crises. An outsourced triage industry already exists to absorb this (IntellaTriage et al.), which validates the spend. The voice agent fits the regulatory seam precisely: it handles *first-touch capture, caregiver coaching on the hospice's own approved protocols, and structured escalation* — while clinical assessment and plan-of-care decisions stay with hospice-employed nurses, preserving the core-services rule ([IntellaTriage/NHPCO guidance](https://intellatriage.com/blog/after-hours-triage-and-core-services-regulation/)).

MVP features in hospice phase:

- **Comfort-care coaching** from the hospice-partner's approved protocols (positioning for dyspnea, mouth care, secretions/"death rattle" normalization, agitation do's-and-don'ts, when *not* to panic).
- **"What to expect" active-dying education** delivered in short, paced, callable modules — the single most-cited unmet need in bereaved-caregiver research.
- **Imminent-death and death-occurrence call scripts**: calm verification protocol, "call the hospice before the funeral home" guidance (a genuinely common and costly mistake), immediate warm transfer to the on-call nurse.
- **Respite activation**: surfacing the Medicare-covered inpatient respite benefit when burden scores spike ([42 CFR §418.108](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418)).

### 6.3 Bereavement: the 13-month relationship nobody fulfills

Medicare requires hospices to offer bereavement support to families for at least 13 months after death — and it's one of the most-cited survey deficiencies: unstructured programs, missed follow-ups, poor documentation ([MyHB Consulting](https://www.myhbconsulting.com/hospice-bereavement-program-deficiencies)). The agent is almost purpose-built for this: scheduled grief check-ins at the hard anniversaries, conversational complicated-grief screening, resource referrals, and documentation a hospice can survey against. This creates the **post-death B2B revenue line** (hospice white-label bereavement programs) and — candidly — the strongest retention/referral engine a consumer brand can have.

---

## 7. ElevenLabs Feature Map for the Caregiver-First Build

| ElevenLabs capability | Caregiver-MVP usage |
|---|---|
| **Workflows (visual graph, per-node scoping)** | The check-in graph in 3.1; per-node KB scoping keeps the legal subagent out of clinical content and the care coach out of legal advice; phase-conditional edges key off the care-phase state machine passed in as a dynamic variable |
| **Webhook tools** | `get_dyad_context`, `get_authority_graph`, `log_burden_score`, `log_collateral_symptoms`, `evaluate_symptoms` (deterministic rules), `advance_legal_task`, `refer_legal_partner`, `refer_hospice_line`, `schedule_family_update`, `send_summary_sms`. Aggressive timeouts + pre-tool filler speech ("let me make a note of that…") |
| **System tools** | `transfer_to_number` with `agent_message` (nurse line, hospice on-call, 988 — warm handoff with SBAR-style context); `language_detection` (mid-call Spanish↔English — equity + the WellSpan-proven engagement lever); `skip_turn` (grief and fatigue need silence tolerance); `end_call` |
| **Dynamic variables** | Per-call injection: `caregiver_name`, `patient_name`, `relationship`, `care_phase`, `authority_flags`, `last_checkin_summary`, `open_legal_tasks`, `hospice_agency_contact`. The "memory" is yours, not the platform's |
| **RAG knowledge base** | Four scoped folders: (1) caregiving skills (NCI PDQ caregiver content, med management, safe handling of chemo at home), (2) symptom home-care guides, (3) legal literacy + state PoA/AD checklists, (4) hospice/comfort-care + grief resources. Clinician- and attorney-reviewed before upload; versioned like code |
| **Guardrails** | Built-ins on, plus three customs: *no medical advice* (escalate), *no legal advice* (educate + refer), *no prognosis* (acknowledge + route to care team). All with deterministic actions, not retries |
| **Client tools (web app)** | Agent-driven UI: display med list, show PoA checklist progress, open document upload, display "call the hospice now" card |
| **Post-call webhooks** | `post_call_transcription` → structured data collection (burden scores, symptom flags, legal task state, phase-change signals) into your Postgres. Under Zero Retention Mode your DB is the only record — which is correct architecture |
| **Testing / simulations** | Adversarial suites per persona: panicked caregiver reporting fever vaguely; caregiver in active grief; Spanish-language collateral report; caregiver asking for legal advice; "how long does she have" probe; unauthorized sibling requesting clinical detail (must be refused). Run in CI on every prompt/config change |
| **Batch vs. individual outbound** | Individual API-initiated calls only — batch calling is incompatible with Zero Retention Mode |

---

## 8. Compliance & Safety Posture

- **HIPAA:** Phase 1 D2C — you're likely not a covered entity/BA, but state health-data laws (WA My Health My Data) and FTC HBNR apply; behave HIPAA-grade from day one. Phase 2 (clinic/hospice partnerships) → Business Associate: ElevenLabs Enterprise + BAA + Zero Retention Mode + BAA-allowlisted models (Claude/Gemini families).
- **Consent stack:** patient consent for caregiver involvement + HIPAA authorization captured at onboarding; TCPA prior express consent for AI-voice outbound calls (recorded on first call); verbal AI disclosure at every call start (Utah/California-style state laws).
- **UPL (unauthorized practice of law):** education + navigation + referral only; scripted disclaimers; attorney-reviewed content; no document interpretation or bespoke drafting.
- **Clinical scope:** non-diagnostic; the rules engine *captures and routes*, clinicians decide. All KB clinical content owned and signed off by licensed clinicians; hospice-phase content co-branded with and approved by each partner hospice's medical director.
- **Crisis protocols:** 988 routing for caregiver suicidal ideation; 911 instruction scripts for acute patient emergencies; imminent-death calls transfer to hospice on-call. All exercised in the simulation suite, not just documented.
- **Unit economics:** ~$0.08/conversation-minute + LLM + telephony ≈ $1.10–1.60 per 10-minute check-in; ~$15–20/dyad/month at weekly cadence — viable at a $29–49/month consumer subscription or a hospice PMPM.

---

## 9. What Makes This Agent Different

1. **It's the only voice product that treats the caregiver as the patient.** Burden screening, training, and respite activation for the 63-million-person workforce that gets 22% training rates and 42% depression prevalence — nobody in the voice-AI field is even measuring this.
2. **The authority graph is a moat.** Modeling PoA/proxy/HIPAA relationships as product infrastructure — and driving families to *complete* them — is simultaneously a compliance layer, a killer feature, and an outcome metric (AD completion lift vs. the 36.7% baseline) that no horizontal competitor can claim.
3. **It spans the trajectory competitors abandon.** Patient-facing oncology tools end at treatment; hospice tools start at enrollment. Holding the dyad's hand *across* the palliative bridge, hospice transition, and 13 months of bereavement is a relationship competitors structurally don't have — and it's where caregiver need peaks.
4. **Second-hand clinical signal.** Capturing red flags from collateral caregiver reports with conservative deterministic scoring is a harder technical problem than patient self-report — and solving it is publishable evidence.
5. **Referral-network effects.** Triage Cancer / CLRC / elder-law / hospice partnerships turn your agent into the front door for an under-discovered support ecosystem — partners gain qualified referrals, you gain distribution and content credibility.
6. **D2C now, B2B later.** Caregivers pay out of pocket today (they average ~$7,200/year in caregiving expenses ([AARP](https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html))); hospices pay tomorrow for after-hours triage support and bereavement-program compliance — a mandated, survey-cited, under-delivered obligation.

### Build sequence (8 weeks to private beta)

| Weeks | Milestone |
|---|---|
| 1–2 | Inbound web-widget agent; caregiver-skills KB (40–60 reviewed docs); care coach subagent only; dogfood with 10 friendly caregivers |
| 3–4 | Outbound check-in workflow; Twilio number; dyad context + authority graph v1; burden tracker; `evaluate_symptoms` rules engine (15–20 conservative rules, clinician-reviewed) |
| 5 | Legal module: state PoA/AD checklists for launch states, `refer_legal_partner` with Triage Cancer/CLRC pathways, UPL-safe scripts |
| 6 | Escalation plumbing (transfer trees, 988/911 protocols, SBAR summaries); simulation suites in CI (incl. unauthorized-caller and prognosis probes) |
| 7 | Hospice-phase content pack + first hospice partner LOI (after-hours pilot); bereavement check-in cadence design |
| 8 | Private beta: 25–40 caregiver dyads; instrument the four proof metrics from day one |

---

*Product-strategy document for planning purposes. Clinical content, escalation thresholds, and legal educational materials must be reviewed and owned by licensed clinicians and attorneys before any user contact. This document does not constitute medical, legal, or regulatory advice.*
