package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const (
	defaultModel       = "llama3.2:3b"
	defaultOllamaAPI   = "http://127.0.0.1:11434"
	defaultThreadTitle = "TriChat TUI"
)

const (
	codePrompt    = "You are Codex in tri-chat mode. Respond with concrete, high-signal engineering advice focused on implementation and reliability tradeoffs."
	cursorPrompt  = "You are Cursor in tri-chat mode. Respond with practical implementation guidance, developer UX suggestions, and concise reasoning."
	imprintPrompt = "You are the local Imprint agent for Anamnesis. Favor deterministic local-first execution, idempotent operations, and explicit next actions."
)

var safeToolPattern = regexp.MustCompile(`[^a-zA-Z0-9]+`)

type appConfig struct {
	repoRoot                     string
	threadID                     string
	threadTitle                  string
	resumeLatest                 bool
	transport                    string
	url                          string
	origin                       string
	stdioCommand                 string
	stdioArgs                    string
	model                        string
	codexCommand                 string
	cursorCommand                string
	imprintCommand               string
	modelTimeoutSeconds          int
	bridgeTimeoutSeconds         int
	adapterFailoverTimeoutSecond int
	adapterCircuitThreshold      int
	adapterCircuitRecoverySecond int
	executeGateMode              string
	executeAllowAgents           map[string]bool
	executeApprovalPhrase        string
	pollInterval                 time.Duration
	launcher                     bool
	altScreen                    bool
	sessionSeed                  string
}

type runtimeSettings struct {
	transport                    string
	model                        string
	fanoutTarget                 string
	executeGateMode              string
	autoRefresh                  bool
	pollInterval                 time.Duration
	modelTimeoutSeconds          int
	bridgeTimeoutSeconds         int
	adapterFailoverTimeoutSecond int
	adapterCircuitThreshold      int
	adapterCircuitRecoverySecond int
}

type mcpCaller struct {
	repoRoot string
	helper   string
	cfg      appConfig
}

func (c mcpCaller) callTool(tool string, args map[string]any) (any, error) {
	payload, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	cmdArgs := []string{
		c.helper,
		"--tool", tool,
		"--args", string(payload),
		"--transport", c.cfg.transport,
		"--url", c.cfg.url,
		"--origin", c.cfg.origin,
		"--stdio-command", c.cfg.stdioCommand,
		"--stdio-args", c.cfg.stdioArgs,
		"--cwd", c.repoRoot,
	}
	cmd := exec.Command("node", cmdArgs...)
	cmd.Dir = c.repoRoot
	cmd.Env = os.Environ()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = err.Error()
		}
		return nil, fmt.Errorf("tool %s failed: %s", tool, errText)
	}
	outText := strings.TrimSpace(stdout.String())
	if outText == "" {
		return map[string]any{}, nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(outText), &parsed); err != nil {
		return nil, fmt.Errorf("invalid tool output for %s: %w", tool, err)
	}
	return parsed, nil
}

func decodeAny[T any](payload any) (T, error) {
	var out T
	buf, err := json.Marshal(payload)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(buf, &out); err != nil {
		return out, err
	}
	return out, nil
}

type mutationFactory struct {
	seed    string
	counter uint64
}

func newMutationFactory(seed string) *mutationFactory {
	clean := strings.TrimSpace(seed)
	if clean == "" {
		clean = fmt.Sprintf("trichat-tui-%d", time.Now().Unix())
	}
	return &mutationFactory{seed: clean}
}

func (m *mutationFactory) next(tool string) map[string]string {
	n := atomic.AddUint64(&m.counter, 1)
	safe := safeToolPattern.ReplaceAllString(strings.ToLower(tool), "-")
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "tool"
	}
	key := fmt.Sprintf("%s-%s-%d", m.seed, safe, n)
	return map[string]string{
		"idempotency_key":         key,
		"side_effect_fingerprint": key + "-fingerprint",
	}
}

type triChatThread struct {
	ThreadID string         `json:"thread_id"`
	Title    string         `json:"title"`
	Status   string         `json:"status"`
	Metadata map[string]any `json:"metadata"`
}

type triChatMessage struct {
	MessageID        string         `json:"message_id"`
	ThreadID         string         `json:"thread_id"`
	CreatedAt        string         `json:"created_at"`
	AgentID          string         `json:"agent_id"`
	Role             string         `json:"role"`
	Content          string         `json:"content"`
	ReplyToMessageID string         `json:"reply_to_message_id"`
	Metadata         map[string]any `json:"metadata"`
}

type triChatTimelineResp struct {
	ThreadID string           `json:"thread_id"`
	Count    int              `json:"count"`
	Messages []triChatMessage `json:"messages"`
}

type taskSummaryResp struct {
	Counts     map[string]int     `json:"counts"`
	Running    []taskRunningLease `json:"running"`
	LastFailed *taskLastFailed    `json:"last_failed"`
}

type taskRunningLease struct {
	TaskID         string `json:"task_id"`
	Objective      string `json:"objective"`
	OwnerID        string `json:"owner_id"`
	LeaseExpiresAt string `json:"lease_expires_at"`
	UpdatedAt      string `json:"updated_at"`
	AttemptCount   int    `json:"attempt_count"`
	MaxAttempts    int    `json:"max_attempts"`
}

type taskLastFailed struct {
	TaskID       string `json:"task_id"`
	LastError    string `json:"last_error"`
	AttemptCount int    `json:"attempt_count"`
	MaxAttempts  int    `json:"max_attempts"`
	UpdatedAt    string `json:"updated_at"`
}

type daemonStatusResp struct {
	Running bool `json:"running"`
}

type triChatSummaryResp struct {
	ThreadCounts struct {
		Active   int `json:"active"`
		Archived int `json:"archived"`
		Total    int `json:"total"`
	} `json:"thread_counts"`
	MessageCount int `json:"message_count"`
}

type adapterTelemetryStatusResp struct {
	Summary struct {
		TotalChannels      int    `json:"total_channels"`
		OpenChannels       int    `json:"open_channels"`
		TotalTrips         int    `json:"total_trips"`
		TotalSuccesses     int    `json:"total_successes"`
		TotalTurns         int    `json:"total_turns"`
		TotalDegradedTurns int    `json:"total_degraded_turns"`
		NewestTripOpenedAt string `json:"newest_trip_opened_at"`
		NewestStateAt      string `json:"newest_state_at"`
		NewestEventAt      string `json:"newest_event_at"`
	} `json:"summary"`
	States         []adapterState `json:"states"`
	RecentEvents   []adapterEvent `json:"recent_events"`
	LastOpenEvents []adapterEvent `json:"last_open_events"`
}

type adapterState struct {
	AgentID           string         `json:"agent_id"`
	Channel           string         `json:"channel"`
	UpdatedAt         string         `json:"updated_at"`
	Open              bool           `json:"open"`
	OpenUntil         string         `json:"open_until"`
	FailureCount      int            `json:"failure_count"`
	TripCount         int            `json:"trip_count"`
	SuccessCount      int            `json:"success_count"`
	LastError         string         `json:"last_error"`
	LastOpenedAt      string         `json:"last_opened_at"`
	TurnCount         int            `json:"turn_count"`
	DegradedTurnCount int            `json:"degraded_turn_count"`
	LastResult        string         `json:"last_result"`
	Metadata          map[string]any `json:"metadata"`
}

type adapterEvent struct {
	EventID   string         `json:"event_id"`
	CreatedAt string         `json:"created_at"`
	AgentID   string         `json:"agent_id"`
	Channel   string         `json:"channel"`
	EventType string         `json:"event_type"`
	OpenUntil string         `json:"open_until"`
	ErrorText string         `json:"error_text"`
	Details   map[string]any `json:"details"`
}

type reliabilitySnapshot struct {
	taskSummary      taskSummaryResp
	taskAutoRetry    daemonStatusResp
	transcriptSquish daemonStatusResp
	triRetention     daemonStatusResp
	triSummary       triChatSummaryResp
	adapterTelemetry adapterTelemetryStatusResp
	updatedAt        time.Time
}

type breakerState struct {
	threshold    int
	recovery     time.Duration
	failureCount int
	openUntil    time.Time
	lastOpenedAt time.Time
	lastError    string
	lastResult   string
	tripCount    int
	successCount int
}

func (b *breakerState) isOpen(now time.Time) bool {
	return !b.openUntil.IsZero() && now.Before(b.openUntil)
}

func (b *breakerState) remaining(now time.Time) time.Duration {
	if b.openUntil.IsZero() {
		return 0
	}
	if now.After(b.openUntil) {
		return 0
	}
	return b.openUntil.Sub(now)
}

func (b *breakerState) recordSuccess(now time.Time) bool {
	wasOpen := b.isOpen(now)
	b.failureCount = 0
	b.openUntil = time.Time{}
	b.lastError = ""
	b.lastResult = "success"
	b.successCount += 1
	return wasOpen
}

func (b *breakerState) recordFailure(now time.Time, errorText string) bool {
	b.failureCount += 1
	b.lastError = compactSingleLine(errorText, 240)
	b.lastResult = "failure"
	if b.failureCount >= maxInt(1, b.threshold) {
		b.tripCount += 1
		b.failureCount = 0
		b.lastOpenedAt = now.UTC()
		b.openUntil = now.Add(maxDuration(time.Second, b.recovery)).UTC()
		b.lastResult = "trip-opened"
		return true
	}
	return false
}

func (b *breakerState) reset() {
	b.failureCount = 0
	b.openUntil = time.Time{}
	b.lastError = ""
	b.lastResult = "reset"
}

type agentRuntime struct {
	mu sync.Mutex

	agentID      string
	systemPrompt string

	commandBreaker breakerState
	modelBreaker   breakerState
	turnCount      int
	degradedTurns  int
}

type agentResponse struct {
	agentID         string
	content         string
	adapterMeta     map[string]any
	telemetryEvents []map[string]any
}

type orchestrator struct {
	mu sync.Mutex

	agents    map[string]*agentRuntime
	bootstrap string
	ollamaAPI string
}

func newOrchestrator(cfg appConfig) *orchestrator {
	buildBreaker := func() breakerState {
		threshold := maxInt(1, cfg.adapterCircuitThreshold)
		recovery := time.Duration(maxInt(1, cfg.adapterCircuitRecoverySecond)) * time.Second
		return breakerState{threshold: threshold, recovery: recovery}
	}
	return &orchestrator{
		agents: map[string]*agentRuntime{
			"codex": {
				agentID:        "codex",
				systemPrompt:   codePrompt,
				commandBreaker: buildBreaker(),
				modelBreaker:   buildBreaker(),
			},
			"cursor": {
				agentID:        "cursor",
				systemPrompt:   cursorPrompt,
				commandBreaker: buildBreaker(),
				modelBreaker:   buildBreaker(),
			},
			"local-imprint": {
				agentID:        "local-imprint",
				systemPrompt:   imprintPrompt,
				commandBreaker: buildBreaker(),
				modelBreaker:   buildBreaker(),
			},
		},
		bootstrap: "",
		ollamaAPI: envOr("TRICHAT_OLLAMA_API_BASE", defaultOllamaAPI),
	}
}

func (o *orchestrator) setBootstrap(text string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.bootstrap = text
}

func (o *orchestrator) bootstrapText() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.bootstrap
}

func (o *orchestrator) restoreStates(states []adapterState, cfg runtimeSettings) {
	for _, state := range states {
		agent := o.agents[state.AgentID]
		if agent == nil {
			continue
		}
		agent.mu.Lock()
		if state.Channel == "command" {
			hydrateBreaker(&agent.commandBreaker, state, cfg)
		} else {
			hydrateBreaker(&agent.modelBreaker, state, cfg)
		}
		agent.turnCount = maxInt(agent.turnCount, state.TurnCount)
		agent.degradedTurns = maxInt(agent.degradedTurns, state.DegradedTurnCount)
		agent.mu.Unlock()
	}
}

func hydrateBreaker(target *breakerState, state adapterState, cfg runtimeSettings) {
	target.threshold = maxInt(1, cfg.adapterCircuitThreshold)
	target.recovery = time.Duration(maxInt(1, cfg.adapterCircuitRecoverySecond)) * time.Second
	target.failureCount = maxInt(0, state.FailureCount)
	target.tripCount = maxInt(0, state.TripCount)
	target.successCount = maxInt(0, state.SuccessCount)
	target.lastError = compactSingleLine(state.LastError, 240)
	target.lastResult = compactSingleLine(state.LastResult, 120)
	if t, err := parseISO(state.OpenUntil); err == nil {
		target.openUntil = t
	}
	if t, err := parseISO(state.LastOpenedAt); err == nil {
		target.lastOpenedAt = t
	}
}

func (o *orchestrator) collectStates(cfg appConfig, settings runtimeSettings) []map[string]any {
	now := time.Now().UTC().Format(time.RFC3339)
	states := make([]map[string]any, 0, 6)
	commands := map[string]string{
		"codex":         cfg.codexCommand,
		"cursor":        cfg.cursorCommand,
		"local-imprint": cfg.imprintCommand,
	}
	for _, agentID := range []string{"codex", "cursor", "local-imprint"} {
		agent := o.agents[agentID]
		if agent == nil {
			continue
		}
		agent.mu.Lock()
		agent.commandBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
		agent.commandBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
		agent.modelBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
		agent.modelBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
		turnCount := agent.turnCount
		degraded := agent.degradedTurns
		commandSnapshot := agent.commandBreaker
		modelSnapshot := agent.modelBreaker
		agent.mu.Unlock()

		states = append(states, breakerToStatePayload(agentID, "command", now, turnCount, degraded, commandSnapshot, commands[agentID] != ""))
		states = append(states, breakerToStatePayload(agentID, "model", now, turnCount, degraded, modelSnapshot, commands[agentID] != ""))
	}
	return states
}

func breakerToStatePayload(agentID, channel, now string, turnCount, degraded int, snapshot breakerState, commandEnabled bool) map[string]any {
	payload := map[string]any{
		"agent_id":            agentID,
		"channel":             channel,
		"updated_at":          now,
		"open":                snapshot.isOpen(time.Now()),
		"failure_count":       snapshot.failureCount,
		"trip_count":          snapshot.tripCount,
		"success_count":       snapshot.successCount,
		"last_error":          snapshot.lastError,
		"turn_count":          turnCount,
		"degraded_turn_count": degraded,
		"last_result":         snapshot.lastResult,
		"metadata": map[string]any{
			"command_enabled": commandEnabled,
		},
	}
	if !snapshot.openUntil.IsZero() {
		payload["open_until"] = snapshot.openUntil.UTC().Format(time.RFC3339)
	}
	if !snapshot.lastOpenedAt.IsZero() {
		payload["last_opened_at"] = snapshot.lastOpenedAt.UTC().Format(time.RFC3339)
	}
	return payload
}

func (o *orchestrator) fanout(prompt string, history []triChatMessage, cfg appConfig, settings runtimeSettings, target string) ([]agentResponse, []map[string]any) {
	agents := fanoutTargets(target)
	responses := make([]agentResponse, 0, len(agents))
	events := make([]map[string]any, 0, 16)
	results := make(chan agentResponse, len(agents))
	var wg sync.WaitGroup

	for _, agentID := range agents {
		agent := o.agents[agentID]
		if agent == nil {
			continue
		}
		wg.Add(1)
		go func(runtime *agentRuntime) {
			defer wg.Done()
			command := commandForAgent(runtime.agentID, cfg)
			response := runtime.respond(prompt, history, o.bootstrapText(), command, cfg, settings, o.ollamaAPI)
			results <- response
		}(agent)
	}

	wg.Wait()
	close(results)

	order := map[string]int{"codex": 0, "cursor": 1, "local-imprint": 2}
	for response := range results {
		responses = append(responses, response)
		events = append(events, response.telemetryEvents...)
	}
	sort.SliceStable(responses, func(i, j int) bool {
		return order[responses[i].agentID] < order[responses[j].agentID]
	})
	return responses, events
}

func fanoutTargets(target string) []string {
	normalized := strings.TrimSpace(strings.ToLower(target))
	switch normalized {
	case "codex", "cursor", "local-imprint":
		return []string{normalized}
	default:
		return []string{"codex", "cursor", "local-imprint"}
	}
}

func commandForAgent(agentID string, cfg appConfig) string {
	switch agentID {
	case "codex":
		return strings.TrimSpace(cfg.codexCommand)
	case "cursor":
		return strings.TrimSpace(cfg.cursorCommand)
	case "local-imprint":
		return strings.TrimSpace(cfg.imprintCommand)
	default:
		return ""
	}
}

func (a *agentRuntime) respond(
	prompt string,
	history []triChatMessage,
	bootstrapText string,
	command string,
	cfg appConfig,
	settings runtimeSettings,
	ollamaAPI string,
) agentResponse {
	start := time.Now()
	deadline := start.Add(time.Duration(maxInt(1, settings.adapterFailoverTimeoutSecond)) * time.Second)
	attempts := make([]string, 0, 4)
	events := make([]map[string]any, 0, 4)

	a.mu.Lock()
	a.turnCount += 1
	a.commandBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
	a.commandBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
	a.modelBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
	a.modelBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
	a.mu.Unlock()

	channels := []string{"model"}
	if strings.TrimSpace(command) != "" {
		channels = []string{"command", "model"}
	}

	messages := buildOllamaMessages(a.systemPrompt, prompt, history, bootstrapText)

	for _, channel := range channels {
		now := time.Now()
		if !now.Before(deadline) {
			attempts = append(attempts, "deadline-exceeded")
			break
		}
		remaining := deadline.Sub(now)
		if channel == "command" {
			a.mu.Lock()
			open := a.commandBreaker.isOpen(now)
			remainingOpen := a.commandBreaker.remaining(now)
			a.mu.Unlock()
			if open {
				attempts = append(attempts, fmt.Sprintf("command:circuit-open(%.1fs)", remainingOpen.Seconds()))
				continue
			}

			timeout := minDuration(remaining, time.Duration(maxInt(1, settings.bridgeTimeoutSeconds))*time.Second)
			content, err := callCommandAdapter(command, map[string]any{
				"agent_id":       a.agentID,
				"prompt":         prompt,
				"history":        history,
				"bootstrap_text": bootstrapText,
				"peer_context":   "",
				"workspace":      cfg.repoRoot,
				"timestamp":      time.Now().UTC().Format(time.RFC3339),
			}, timeout)
			if err == nil {
				a.mu.Lock()
				recovered := a.commandBreaker.recordSuccess(time.Now())
				turnCount := a.turnCount
				degraded := a.degradedTurns
				status := a.snapshotStateLocked(command != "", turnCount, degraded)
				a.mu.Unlock()
				if recovered {
					events = append(events, telemetryEvent(a.agentID, "command", "recovered", "", "", map[string]any{"path": "command"}))
				}
				meta := map[string]any{
					"adapter":  "command",
					"command":  command,
					"degraded": false,
					"attempts": attempts,
					"circuit":  status,
				}
				if len(attempts) > 0 {
					content = "[failover recovered via command after: " + strings.Join(attempts, "; ") + "]\n\n" + content
				}
				return agentResponse{agentID: a.agentID, content: content, adapterMeta: meta, telemetryEvents: events}
			}

			errText := fmt.Sprintf("%T: %v", err, err)
			a.mu.Lock()
			tripped := a.commandBreaker.recordFailure(time.Now(), errText)
			openUntil := a.commandBreaker.openUntil
			lastError := a.commandBreaker.lastError
			a.mu.Unlock()
			if tripped {
				events = append(events, telemetryEvent(a.agentID, "command", "trip_opened", lastError, openUntil.Format(time.RFC3339), map[string]any{"path": "command", "threshold": maxInt(1, settings.adapterCircuitThreshold)}))
			}
			attempts = append(attempts, "command:failed("+compactSingleLine(errText, 120)+")")
			continue
		}

		a.mu.Lock()
		open := a.modelBreaker.isOpen(now)
		remainingOpen := a.modelBreaker.remaining(now)
		a.mu.Unlock()
		if open {
			attempts = append(attempts, fmt.Sprintf("ollama:circuit-open(%.1fs)", remainingOpen.Seconds()))
			continue
		}

		timeout := minDuration(remaining, time.Duration(maxInt(1, settings.modelTimeoutSeconds))*time.Second)
		content, err := callOllama(ollamaAPI, settings.model, messages, timeout)
		if err == nil {
			a.mu.Lock()
			recovered := a.modelBreaker.recordSuccess(time.Now())
			turnCount := a.turnCount
			degraded := a.degradedTurns
			status := a.snapshotStateLocked(command != "", turnCount, degraded)
			a.mu.Unlock()
			if recovered {
				events = append(events, telemetryEvent(a.agentID, "model", "recovered", "", "", map[string]any{"path": "ollama"}))
			}
			meta := map[string]any{
				"adapter":  "ollama",
				"model":    settings.model,
				"degraded": false,
				"attempts": attempts,
				"circuit":  status,
			}
			if len(attempts) > 0 {
				content = "[failover recovered via ollama after: " + strings.Join(attempts, "; ") + "]\n\n" + content
			}
			return agentResponse{agentID: a.agentID, content: content, adapterMeta: meta, telemetryEvents: events}
		}

		errText := fmt.Sprintf("%T: %v", err, err)
		a.mu.Lock()
		tripped := a.modelBreaker.recordFailure(time.Now(), errText)
		openUntil := a.modelBreaker.openUntil
		lastError := a.modelBreaker.lastError
		a.mu.Unlock()
		if tripped {
			events = append(events, telemetryEvent(a.agentID, "model", "trip_opened", lastError, openUntil.Format(time.RFC3339), map[string]any{"path": "ollama", "threshold": maxInt(1, settings.adapterCircuitThreshold)}))
		}
		attempts = append(attempts, "ollama:failed("+compactSingleLine(errText, 120)+")")
	}

	a.mu.Lock()
	a.degradedTurns += 1
	turnCount := a.turnCount
	degraded := a.degradedTurns
	status := a.snapshotStateLocked(command != "", turnCount, degraded)
	a.mu.Unlock()

	reason := "no-channel-attempted"
	if len(attempts) > 0 {
		start := len(attempts) - 3
		if start < 0 {
			start = 0
		}
		reason = strings.Join(attempts[start:], "; ")
	}
	events = append(events, telemetryEvent(a.agentID, "model", "degraded_turn", "", "", map[string]any{"reason": reason}))
	content := fmt.Sprintf("[degraded-mode] %s unavailable for live inference this turn. Reason: %s. Continuing without blocking the tri-chat turn.", a.agentID, reason)
	meta := map[string]any{
		"adapter":  "degraded",
		"model":    settings.model,
		"degraded": true,
		"reason":   reason,
		"attempts": attempts,
		"circuit":  status,
	}
	return agentResponse{agentID: a.agentID, content: content, adapterMeta: meta, telemetryEvents: events}
}

func (a *agentRuntime) snapshotStateLocked(commandEnabled bool, turnCount, degraded int) map[string]any {
	return map[string]any{
		"command": map[string]any{
			"open":                 a.commandBreaker.isOpen(time.Now()),
			"remaining_seconds":    maxFloat(0, a.commandBreaker.remaining(time.Now()).Seconds()),
			"open_until_epoch":     epochOrNil(a.commandBreaker.openUntil),
			"last_opened_at_epoch": epochOrNil(a.commandBreaker.lastOpenedAt),
			"failure_count":        a.commandBreaker.failureCount,
			"last_error":           nullIfEmpty(a.commandBreaker.lastError),
			"last_result":          nullIfEmpty(a.commandBreaker.lastResult),
			"trip_count":           a.commandBreaker.tripCount,
			"success_count":        a.commandBreaker.successCount,
			"threshold":            a.commandBreaker.threshold,
			"recovery_seconds":     int(a.commandBreaker.recovery.Seconds()),
		},
		"model": map[string]any{
			"open":                 a.modelBreaker.isOpen(time.Now()),
			"remaining_seconds":    maxFloat(0, a.modelBreaker.remaining(time.Now()).Seconds()),
			"open_until_epoch":     epochOrNil(a.modelBreaker.openUntil),
			"last_opened_at_epoch": epochOrNil(a.modelBreaker.lastOpenedAt),
			"failure_count":        a.modelBreaker.failureCount,
			"last_error":           nullIfEmpty(a.modelBreaker.lastError),
			"last_result":          nullIfEmpty(a.modelBreaker.lastResult),
			"trip_count":           a.modelBreaker.tripCount,
			"success_count":        a.modelBreaker.successCount,
			"threshold":            a.modelBreaker.threshold,
			"recovery_seconds":     int(a.modelBreaker.recovery.Seconds()),
		},
		"turn_count":          turnCount,
		"degraded_turn_count": degraded,
		"command_enabled":     commandEnabled,
	}
}

func telemetryEvent(agentID, channel, eventType, errorText, openUntil string, details map[string]any) map[string]any {
	payload := map[string]any{
		"agent_id":   agentID,
		"channel":    channel,
		"event_type": eventType,
		"details":    details,
	}
	if strings.TrimSpace(errorText) != "" {
		payload["error_text"] = compactSingleLine(errorText, 240)
	}
	if strings.TrimSpace(openUntil) != "" {
		payload["open_until"] = openUntil
	}
	return payload
}

func buildOllamaMessages(systemPrompt, prompt string, history []triChatMessage, bootstrap string) []map[string]string {
	historyLines := make([]string, 0, 30)
	start := 0
	if len(history) > 30 {
		start = len(history) - 30
	}
	for _, msg := range history[start:] {
		historyLines = append(historyLines, fmt.Sprintf("[%s/%s] %s", msg.AgentID, msg.Role, compactSingleLine(msg.Content, 300)))
	}
	historyBlock := "(no prior messages)"
	if len(historyLines) > 0 {
		historyBlock = strings.Join(historyLines, "\n")
	}
	parts := []string{
		"TriChat user request:",
		strings.TrimSpace(prompt),
		"",
		"Recent thread history:",
		historyBlock,
	}
	if strings.TrimSpace(bootstrap) != "" {
		parts = append(parts, "", "Imprint bootstrap context:", truncate(bootstrap, 3000))
	}
	user := strings.TrimSpace(strings.Join(parts, "\n"))
	return []map[string]string{
		{"role": "system", "content": systemPrompt},
		{"role": "user", "content": user},
	}
}

func callCommandAdapter(command string, payload map[string]any, timeout time.Duration) (string, error) {
	parts := splitCommand(command)
	if len(parts) == 0 {
		return "", errors.New("empty command adapter")
	}
	ctx, cancel := context.WithTimeout(context.Background(), maxDuration(time.Second, timeout))
	defer cancel()
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	input, _ := json.Marshal(payload)
	cmd.Stdin = bytes.NewReader(input)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("bridge timeout")
		}
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("bridge command failed: %s", errText)
	}
	output := strings.TrimSpace(stdout.String())
	if output == "" {
		return "", errors.New("bridge command returned empty stdout")
	}
	var parsed any
	if err := json.Unmarshal([]byte(output), &parsed); err == nil {
		switch value := parsed.(type) {
		case map[string]any:
			if content, ok := value["content"].(string); ok && strings.TrimSpace(content) != "" {
				return strings.TrimSpace(content), nil
			}
		case string:
			if strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value), nil
			}
		}
	}
	return output, nil
}

func callOllama(apiBase, model string, messages []map[string]string, timeout time.Duration) (string, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(apiBase), "/") + "/api/chat"
	body := map[string]any{
		"model":    model,
		"stream":   false,
		"messages": messages,
		"options":  map[string]any{"temperature": 0.2},
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: maxDuration(time.Second, timeout)}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("ollama request failed on /api/chat: %w", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("ollama http %d: %s", resp.StatusCode, compactSingleLine(string(payload), 240))
	}
	var parsed struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", fmt.Errorf("ollama returned non-json payload")
	}
	content := strings.TrimSpace(parsed.Message.Content)
	if content == "" {
		return "", errors.New("ollama returned empty response content")
	}
	return content, nil
}

type tabID int

const (
	tabChat tabID = iota
	tabReliability
	tabSettings
	tabHelp
)

type model struct {
	cfg      appConfig
	settings runtimeSettings
	caller   mcpCaller
	mutation *mutationFactory
	orch     *orchestrator

	threadID    string
	threadTitle string
	messages    []triChatMessage
	reliability reliabilitySnapshot

	ready          bool
	startupErr     error
	statusLine     string
	logs           []string
	activeTab      tabID
	settingsIndex  int
	launcherActive bool
	launcherIndex  int
	launcherItems  []string
	launcherPulse  int
	inflight       bool
	refreshing     bool
	lastRefresh    time.Time

	width  int
	height int

	input    textinput.Model
	timeline viewport.Model
	sidebar  viewport.Model
	spinner  spinner.Model

	theme uiTheme
}

type initDoneMsg struct {
	threadID    string
	threadTitle string
	bootstrap   string
	states      []adapterState
	err         error
}

type refreshDoneMsg struct {
	messages    []triChatMessage
	reliability reliabilitySnapshot
	err         error
}

type actionDoneMsg struct {
	status      string
	err         error
	threadID    string
	threadTitle string
	refresh     bool
}

type tickMsg time.Time

type uiTheme struct {
	root               lipgloss.Style
	header             lipgloss.Style
	tabActive          lipgloss.Style
	tabInactive        lipgloss.Style
	panel              lipgloss.Style
	panelTitle         lipgloss.Style
	footer             lipgloss.Style
	status             lipgloss.Style
	errorStatus        lipgloss.Style
	inputPanel         lipgloss.Style
	chatAgent          map[string]lipgloss.Style
	helpText           lipgloss.Style
	settingKey         lipgloss.Style
	settingValue       lipgloss.Style
	settingPick        lipgloss.Style
	launcherFrame      lipgloss.Style
	launcherFrameAlt   lipgloss.Style
	launcherTitle      lipgloss.Style
	launcherTitlePulse lipgloss.Style
	launcherAccent     lipgloss.Style
	launcherOption     lipgloss.Style
	launcherSelect     lipgloss.Style
	launcherBoot       lipgloss.Style
	launcherReady      lipgloss.Style
	launcherMuted      lipgloss.Style
	launcherScanlineA  lipgloss.Style
	launcherScanlineB  lipgloss.Style
}

func newTheme() uiTheme {
	pink := lipgloss.Color("#ff71ce")
	blue := lipgloss.Color("#01cdfe")
	mint := lipgloss.Color("#05ffa1")
	bg := lipgloss.Color("#120924")
	panelBg := lipgloss.Color("#1b0f35")
	text := lipgloss.Color("#f3f3ff")
	muted := lipgloss.Color("#9ca3d8")

	return uiTheme{
		root: lipgloss.NewStyle().
			Background(bg).
			Foreground(text).
			Padding(0, 1),
		header: lipgloss.NewStyle().
			Background(panelBg).
			Foreground(text).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(blue).
			Padding(0, 1),
		tabActive: lipgloss.NewStyle().
			Background(pink).
			Foreground(lipgloss.Color("#22062f")).
			Bold(true).
			Padding(0, 1),
		tabInactive: lipgloss.NewStyle().
			Background(lipgloss.Color("#2a184a")).
			Foreground(muted).
			Padding(0, 1),
		panel: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(blue).
			Padding(0, 1),
		panelTitle: lipgloss.NewStyle().
			Foreground(mint).
			Bold(true),
		footer: lipgloss.NewStyle().
			Background(panelBg).
			Foreground(muted).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(pink).
			Padding(0, 1),
		status:      lipgloss.NewStyle().Foreground(blue).Bold(true),
		errorStatus: lipgloss.NewStyle().Foreground(pink).Bold(true),
		inputPanel: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(mint).
			Padding(0, 1),
		helpText:     lipgloss.NewStyle().Foreground(muted),
		settingKey:   lipgloss.NewStyle().Foreground(blue),
		settingValue: lipgloss.NewStyle().Foreground(text),
		settingPick:  lipgloss.NewStyle().Foreground(pink).Bold(true),
		launcherFrame: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.ThickBorder()).
			BorderForeground(pink).
			Padding(1, 2),
		launcherFrameAlt: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.ThickBorder()).
			BorderForeground(blue).
			Padding(1, 2),
		launcherTitle: lipgloss.NewStyle().
			Foreground(blue).
			Bold(true),
		launcherTitlePulse: lipgloss.NewStyle().
			Foreground(pink).
			Bold(true),
		launcherAccent: lipgloss.NewStyle().
			Foreground(mint).
			Bold(true),
		launcherOption: lipgloss.NewStyle().
			Foreground(text),
		launcherSelect: lipgloss.NewStyle().
			Foreground(lipgloss.Color("#22062f")).
			Background(pink).
			Bold(true).
			Padding(0, 1),
		launcherBoot:  lipgloss.NewStyle().Foreground(lipgloss.Color("#ffd166")).Bold(true),
		launcherReady: lipgloss.NewStyle().Foreground(mint).Bold(true),
		launcherMuted: lipgloss.NewStyle().Foreground(muted),
		launcherScanlineA: lipgloss.NewStyle().
			Background(panelBg),
		launcherScanlineB: lipgloss.NewStyle().
			Background(lipgloss.Color("#21103f")),
		chatAgent: map[string]lipgloss.Style{
			"user":          lipgloss.NewStyle().Foreground(mint).Bold(true),
			"codex":         lipgloss.NewStyle().Foreground(pink).Bold(true),
			"cursor":        lipgloss.NewStyle().Foreground(blue).Bold(true),
			"local-imprint": lipgloss.NewStyle().Foreground(lipgloss.Color("#ffd166")).Bold(true),
			"router":        lipgloss.NewStyle().Foreground(muted).Bold(true),
			"system":        lipgloss.NewStyle().Foreground(muted).Bold(true),
		},
	}
}

func newModel(cfg appConfig) model {
	input := textinput.New()
	input.Prompt = "❯ "
	input.CharLimit = 4000
	input.Placeholder = "Type normally to fan out to codex/cursor/local-imprint. Slash commands are optional."
	if cfg.launcher {
		input.Blur()
	} else {
		input.Focus()
	}

	sp := spinner.New()
	sp.Spinner = spinner.Points
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("#05ffa1"))

	settings := runtimeSettings{
		transport:                    cfg.transport,
		model:                        cfg.model,
		fanoutTarget:                 "all",
		executeGateMode:              cfg.executeGateMode,
		autoRefresh:                  true,
		pollInterval:                 cfg.pollInterval,
		modelTimeoutSeconds:          cfg.modelTimeoutSeconds,
		bridgeTimeoutSeconds:         cfg.bridgeTimeoutSeconds,
		adapterFailoverTimeoutSecond: cfg.adapterFailoverTimeoutSecond,
		adapterCircuitThreshold:      cfg.adapterCircuitThreshold,
		adapterCircuitRecoverySecond: cfg.adapterCircuitRecoverySecond,
	}

	caller := mcpCaller{
		repoRoot: cfg.repoRoot,
		helper:   filepath.Join(cfg.repoRoot, "scripts", "mcp_tool_call.mjs"),
		cfg:      cfg,
	}

	return model{
		cfg:            cfg,
		settings:       settings,
		caller:         caller,
		mutation:       newMutationFactory(cfg.sessionSeed),
		orch:           newOrchestrator(cfg),
		threadID:       cfg.threadID,
		threadTitle:    cfg.threadTitle,
		statusLine:     "starting...",
		logs:           []string{},
		activeTab:      tabChat,
		launcherActive: cfg.launcher,
		launcherIndex:  0,
		launcherItems: []string{
			"Start Tri-Chat",
			"Open Reliability",
			"Open Settings",
			"Open Help",
			"Quit",
		},
		input:    input,
		timeline: viewport.New(0, 0),
		sidebar:  viewport.New(0, 0),
		spinner:  sp,
		theme:    newTheme(),
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		m.initCmd(),
		tickEvery(m.settings.pollInterval),
	)
}

func (m model) initCmd() tea.Cmd {
	cfg := m.cfg
	caller := m.caller
	mutation := m.mutation
	return func() tea.Msg {
		toolPayload, err := caller.callTool("health.tools", map[string]any{})
		if err != nil {
			return initDoneMsg{err: err}
		}
		var health struct {
			Tools []string `json:"tools"`
		}
		health, _ = decodeAny[struct {
			Tools []string `json:"tools"`
		}](toolPayload)
		required := []string{
			"trichat.thread_open",
			"trichat.thread_list",
			"trichat.thread_get",
			"trichat.message_post",
			"trichat.timeline",
			"trichat.summary",
			"trichat.adapter_telemetry",
			"task.summary",
			"task.auto_retry",
			"transcript.auto_squish",
			"trichat.auto_retention",
		}
		missing := missingTools(health.Tools, required)
		if len(missing) > 0 {
			return initDoneMsg{err: fmt.Errorf("server missing required tools: %s", strings.Join(missing, ", "))}
		}

		threadID := strings.TrimSpace(cfg.threadID)
		threadTitle := strings.TrimSpace(cfg.threadTitle)
		if threadTitle == "" {
			threadTitle = defaultThreadTitle
		}

		if threadID == "" && cfg.resumeLatest {
			payload, err := caller.callTool("trichat.thread_list", map[string]any{"status": "active", "limit": 1})
			if err == nil {
				var listing struct {
					Threads []triChatThread `json:"threads"`
				}
				listing, _ = decodeAny[struct {
					Threads []triChatThread `json:"threads"`
				}](payload)
				if len(listing.Threads) > 0 {
					threadID = listing.Threads[0].ThreadID
					if listing.Threads[0].Title != "" {
						threadTitle = listing.Threads[0].Title
					}
				}
			}
		}

		if threadID == "" {
			threadID = fmt.Sprintf("trichat-%d", time.Now().Unix())
		}

		openArgs := map[string]any{
			"mutation":  mutation.next("trichat.thread_open"),
			"thread_id": threadID,
			"title":     threadTitle,
			"metadata": map[string]any{
				"source":    "cmd/trichat-tui",
				"resume":    cfg.resumeLatest,
				"transport": cfg.transport,
			},
		}
		if _, err := caller.callTool("trichat.thread_open", openArgs); err != nil {
			return initDoneMsg{err: err}
		}

		bootstrap := ""
		bootstrapPayload, err := caller.callTool("imprint.bootstrap", map[string]any{
			"profile_id":           "default",
			"max_memories":         20,
			"max_transcript_lines": 20,
			"max_snapshots":        5,
		})
		if err == nil {
			var parsed struct {
				BootstrapText string `json:"bootstrap_text"`
			}
			parsed, _ = decodeAny[struct {
				BootstrapText string `json:"bootstrap_text"`
			}](bootstrapPayload)
			bootstrap = parsed.BootstrapText
		}

		telemetryPayload, err := caller.callTool("trichat.adapter_telemetry", map[string]any{
			"action":         "status",
			"include_events": false,
			"event_limit":    0,
		})
		if err != nil {
			return initDoneMsg{threadID: threadID, threadTitle: threadTitle, bootstrap: bootstrap}
		}
		telemetry, err := decodeAny[adapterTelemetryStatusResp](telemetryPayload)
		if err != nil {
			return initDoneMsg{threadID: threadID, threadTitle: threadTitle, bootstrap: bootstrap}
		}
		return initDoneMsg{threadID: threadID, threadTitle: threadTitle, bootstrap: bootstrap, states: telemetry.States}
	}
}

func missingTools(actual, required []string) []string {
	set := make(map[string]bool, len(actual))
	for _, name := range actual {
		set[name] = true
	}
	missing := make([]string, 0)
	for _, name := range required {
		if !set[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

func tickEvery(interval time.Duration) tea.Cmd {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	return tea.Tick(interval, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m model) refreshCmd() tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	return func() tea.Msg {
		reliability := reliabilitySnapshot{}
		timelinePayload, err := caller.callTool("trichat.timeline", map[string]any{
			"thread_id": threadID,
			"limit":     240,
		})
		if err != nil {
			return refreshDoneMsg{err: err}
		}
		timeline, err := decodeAny[triChatTimelineResp](timelinePayload)
		if err != nil {
			return refreshDoneMsg{err: err}
		}

		taskSummaryPayload, err := caller.callTool("task.summary", map[string]any{"running_limit": 10})
		if err == nil {
			reliability.taskSummary, _ = decodeAny[taskSummaryResp](taskSummaryPayload)
		}
		autoRetryPayload, err := caller.callTool("task.auto_retry", map[string]any{"action": "status"})
		if err == nil {
			reliability.taskAutoRetry, _ = decodeAny[daemonStatusResp](autoRetryPayload)
		}
		autoSquishPayload, err := caller.callTool("transcript.auto_squish", map[string]any{"action": "status"})
		if err == nil {
			reliability.transcriptSquish, _ = decodeAny[daemonStatusResp](autoSquishPayload)
		}
		triRetPayload, err := caller.callTool("trichat.auto_retention", map[string]any{"action": "status"})
		if err == nil {
			reliability.triRetention, _ = decodeAny[daemonStatusResp](triRetPayload)
		}
		triSummaryPayload, err := caller.callTool("trichat.summary", map[string]any{"busiest_limit": 5})
		if err == nil {
			reliability.triSummary, _ = decodeAny[triChatSummaryResp](triSummaryPayload)
		}
		telemetryPayload, err := caller.callTool("trichat.adapter_telemetry", map[string]any{
			"action":         "status",
			"include_events": true,
			"event_limit":    8,
		})
		if err == nil {
			reliability.adapterTelemetry, _ = decodeAny[adapterTelemetryStatusResp](telemetryPayload)
		}
		reliability.updatedAt = time.Now()
		return refreshDoneMsg{messages: timeline.Messages, reliability: reliability}
	}
}

func (m model) postMessageCmd(agentID, role, content string, replyTo string, metadata map[string]any) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation.next("trichat.message_post")
	return func() tea.Msg {
		args := map[string]any{
			"mutation":  mutation,
			"thread_id": threadID,
			"agent_id":  agentID,
			"role":      role,
			"content":   content,
			"metadata":  metadata,
		}
		if strings.TrimSpace(replyTo) != "" {
			args["reply_to_message_id"] = replyTo
		}
		_, err := caller.callTool("trichat.message_post", args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		return actionDoneMsg{status: "message posted", refresh: true}
	}
}

func (m model) fanoutCmd(prompt string, target string) tea.Cmd {
	caller := m.caller
	cfg := m.cfg
	settings := m.settings
	threadID := m.threadID
	mutation := m.mutation
	orch := m.orch
	currentMessages := append([]triChatMessage{}, m.messages...)
	return func() tea.Msg {
		userMutation := mutation.next("trichat.message_post")
		userPostPayload := map[string]any{
			"mutation":  userMutation,
			"thread_id": threadID,
			"agent_id":  "user",
			"role":      "user",
			"content":   prompt,
			"metadata":  map[string]any{"kind": "user-turn", "source": "trichat-tui"},
		}
		postResult, err := caller.callTool("trichat.message_post", userPostPayload)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		var posted struct {
			Message struct {
				MessageID string `json:"message_id"`
			} `json:"message"`
		}
		posted, _ = decodeAny[struct {
			Message struct {
				MessageID string `json:"message_id"`
			} `json:"message"`
		}](postResult)
		userMessageID := posted.Message.MessageID

		historyPayload, err := caller.callTool("trichat.timeline", map[string]any{"thread_id": threadID, "limit": 90})
		if err != nil {
			return actionDoneMsg{err: err}
		}
		history, err := decodeAny[triChatTimelineResp](historyPayload)
		if err != nil {
			history.Messages = currentMessages
		}

		responses, events := orch.fanout(prompt, history.Messages, cfg, settings, target)
		for _, response := range responses {
			postArgs := map[string]any{
				"mutation":            mutation.next("trichat.message_post"),
				"thread_id":           threadID,
				"agent_id":            response.agentID,
				"role":                "assistant",
				"content":             response.content,
				"reply_to_message_id": userMessageID,
				"metadata": map[string]any{
					"kind":    "fanout-response",
					"source":  "trichat-tui",
					"adapter": response.adapterMeta,
				},
			}
			if _, err := caller.callTool("trichat.message_post", postArgs); err != nil {
				return actionDoneMsg{err: err}
			}
		}

		states := orch.collectStates(cfg, settings)
		recordArgs := map[string]any{
			"action":   "record",
			"mutation": mutation.next("trichat.adapter_telemetry"),
			"states":   states,
		}
		if len(events) > 0 {
			recordArgs["events"] = events
		}
		_, _ = caller.callTool("trichat.adapter_telemetry", recordArgs)

		if target == "all" {
			return actionDoneMsg{status: "fanout complete: codex, cursor, local-imprint", refresh: true}
		}
		return actionDoneMsg{status: "response complete: " + target, refresh: true}
	}
}

func (m model) trichatRetentionCmd(days int, applyAll bool, doApply bool) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation.next("trichat.retention")
	return func() tea.Msg {
		args := map[string]any{
			"mutation":        mutation,
			"older_than_days": days,
			"limit":           2000,
			"dry_run":         !doApply,
		}
		if !applyAll {
			args["thread_id"] = threadID
		}
		payload, err := caller.callTool("trichat.retention", args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		var result struct {
			CandidateCount int  `json:"candidate_count"`
			DeletedCount   int  `json:"deleted_count"`
			DryRun         bool `json:"dry_run"`
		}
		result, _ = decodeAny[struct {
			CandidateCount int  `json:"candidate_count"`
			DeletedCount   int  `json:"deleted_count"`
			DryRun         bool `json:"dry_run"`
		}](payload)
		status := fmt.Sprintf("retention %s candidates=%d deleted=%d", ternary(result.DryRun, "dry-run", "apply"), result.CandidateCount, result.DeletedCount)
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m model) daemonActionCmd(toolName, action string) tea.Cmd {
	caller := m.caller
	mutation := m.mutation
	return func() tea.Msg {
		args := map[string]any{"action": action}
		if action != "status" {
			args["mutation"] = mutation.next(toolName)
			if action == "start" {
				args["run_immediately"] = true
			}
		}
		payload, err := caller.callTool(toolName, args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		buf, _ := json.Marshal(payload)
		status := fmt.Sprintf("%s %s", toolName, compactSingleLine(string(buf), 140))
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m model) threadCommandCmd(parts []string) tea.Cmd {
	caller := m.caller
	mutation := m.mutation
	currentThreadID := m.threadID
	if len(parts) == 0 {
		return func() tea.Msg {
			return actionDoneMsg{status: "usage: /thread list [limit] | /thread new [title] | /thread use <id> | /thread archive [id]"}
		}
	}
	action := strings.ToLower(parts[0])
	switch action {
	case "list":
		limit := 15
		if len(parts) > 1 {
			if parsed, err := strconv.Atoi(parts[1]); err == nil {
				limit = parsed
			}
		}
		return func() tea.Msg {
			payload, err := caller.callTool("trichat.thread_list", map[string]any{"status": "active", "limit": maxInt(1, minInt(limit, 100))})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			var listing struct {
				Threads []triChatThread `json:"threads"`
			}
			listing, _ = decodeAny[struct {
				Threads []triChatThread `json:"threads"`
			}](payload)
			if len(listing.Threads) == 0 {
				return actionDoneMsg{status: "no active threads"}
			}
			lines := make([]string, 0, len(listing.Threads))
			for _, thread := range listing.Threads {
				lines = append(lines, fmt.Sprintf("%s (%s)", thread.ThreadID, nullCoalesce(thread.Title, "untitled")))
			}
			return actionDoneMsg{status: "threads: " + compactSingleLine(strings.Join(lines, " | "), 200)}
		}
	case "new":
		title := strings.TrimSpace(strings.Join(parts[1:], " "))
		if title == "" {
			title = fmt.Sprintf("TriChat %s", time.Now().Format("2006-01-02 15:04"))
		}
		threadID := fmt.Sprintf("trichat-%d", time.Now().Unix())
		return func() tea.Msg {
			_, err := caller.callTool("trichat.thread_open", map[string]any{
				"mutation":  mutation.next("trichat.thread_open"),
				"thread_id": threadID,
				"title":     title,
				"metadata":  map[string]any{"source": "trichat-tui", "created_by": "thread-new"},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: "now using thread " + threadID, threadID: threadID, threadTitle: title, refresh: true}
		}
	case "use":
		if len(parts) < 2 {
			return func() tea.Msg { return actionDoneMsg{status: "usage: /thread use <thread_id>"} }
		}
		threadID := strings.TrimSpace(parts[1])
		return func() tea.Msg {
			payload, err := caller.callTool("trichat.thread_get", map[string]any{"thread_id": threadID})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			var threadGet struct {
				Found  bool          `json:"found"`
				Thread triChatThread `json:"thread"`
			}
			threadGet, _ = decodeAny[struct {
				Found  bool          `json:"found"`
				Thread triChatThread `json:"thread"`
			}](payload)
			if !threadGet.Found {
				return actionDoneMsg{status: "thread not found: " + threadID}
			}
			_, err = caller.callTool("trichat.thread_open", map[string]any{
				"mutation":  mutation.next("trichat.thread_open"),
				"thread_id": threadID,
				"status":    "active",
				"metadata":  map[string]any{"source": "trichat-tui", "resumed": true},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: "now using thread " + threadID, threadID: threadID, threadTitle: threadGet.Thread.Title, refresh: true}
		}
	case "archive":
		threadID := currentThreadID
		if len(parts) > 1 {
			threadID = strings.TrimSpace(parts[1])
		}
		return func() tea.Msg {
			_, err := caller.callTool("trichat.thread_open", map[string]any{
				"mutation":  mutation.next("trichat.thread_open"),
				"thread_id": threadID,
				"status":    "archived",
				"metadata":  map[string]any{"source": "trichat-tui", "archived": true},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: "archived thread " + threadID, refresh: true}
		}
	default:
		return func() tea.Msg {
			return actionDoneMsg{status: "usage: /thread list [limit] | /thread new [title] | /thread use <id> | /thread archive [id]"}
		}
	}
}

func (m model) executeCmd(agentID, objective string) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation
	gateMode := m.settings.executeGateMode
	allow := m.cfg.executeAllowAgents
	approvalPhrase := m.cfg.executeApprovalPhrase
	return func() tea.Msg {
		normalizedAgent := strings.ToLower(strings.TrimSpace(agentID))
		if normalizedAgent == "" {
			return actionDoneMsg{status: "usage: /execute <agent> [objective]"}
		}
		if gateMode == "allowlist" && !allow[normalizedAgent] {
			return actionDoneMsg{status: fmt.Sprintf("/execute blocked: %s not in allowlist", normalizedAgent)}
		}
		if gateMode == "approval" {
			if !strings.Contains(objective, approvalPhrase) {
				return actionDoneMsg{status: fmt.Sprintf("/execute blocked: include approval phrase '%s' in objective", approvalPhrase)}
			}
		}

		if strings.TrimSpace(objective) == "" {
			timelinePayload, err := caller.callTool("trichat.timeline", map[string]any{"thread_id": threadID, "limit": 140})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			timeline, err := decodeAny[triChatTimelineResp](timelinePayload)
			if err != nil {
				return actionDoneMsg{err: err}
			}
			for i := len(timeline.Messages) - 1; i >= 0; i-- {
				msg := timeline.Messages[i]
				if msg.AgentID == normalizedAgent && msg.Role == "assistant" {
					objective = compactSingleLine(msg.Content, 220)
					break
				}
			}
		}
		if strings.TrimSpace(objective) == "" {
			return actionDoneMsg{status: "no objective found from latest agent message"}
		}

		taskPayload := map[string]any{
			"mutation":      mutation.next("task.create"),
			"objective":     objective,
			"project_dir":   m.cfg.repoRoot,
			"priority":      50,
			"source":        "trichat.execute",
			"source_client": "trichat-tui",
			"metadata": map[string]any{
				"thread_id": threadID,
				"agent_id":  normalizedAgent,
				"gate_mode": gateMode,
			},
		}
		createdPayload, err := caller.callTool("task.create", taskPayload)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		createdJSON, _ := json.Marshal(createdPayload)
		status := "task created: " + compactSingleLine(string(createdJSON), 160)

		_, _ = caller.callTool("trichat.message_post", map[string]any{
			"mutation":  mutation.next("trichat.message_post"),
			"thread_id": threadID,
			"agent_id":  "router",
			"role":      "system",
			"content":   status,
			"metadata":  map[string]any{"kind": "command-route", "command": "/execute"},
		})
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	switch msg := msg.(type) {
	case initDoneMsg:
		if msg.err != nil {
			m.startupErr = msg.err
			m.statusLine = "startup failed"
			m.logError(msg.err)
			return m, nil
		}
		m.threadID = msg.threadID
		m.threadTitle = msg.threadTitle
		m.orch.setBootstrap(msg.bootstrap)
		m.orch.restoreStates(msg.states, m.settings)
		m.ready = true
		m.statusLine = fmt.Sprintf("ready · thread=%s", m.threadID)
		cmds = append(cmds, m.refreshCmd())
	case refreshDoneMsg:
		m.refreshing = false
		if msg.err != nil {
			m.logError(msg.err)
			m.statusLine = "refresh failed"
			break
		}
		m.messages = msg.messages
		m.reliability = msg.reliability
		m.lastRefresh = time.Now()
		m.renderPanes()
	case actionDoneMsg:
		m.inflight = false
		if msg.err != nil {
			m.logError(msg.err)
			m.statusLine = "action failed"
		} else if strings.TrimSpace(msg.status) != "" {
			m.statusLine = msg.status
			m.appendLog(msg.status)
		}
		if strings.TrimSpace(msg.threadID) != "" {
			m.threadID = msg.threadID
		}
		if strings.TrimSpace(msg.threadTitle) != "" {
			m.threadTitle = msg.threadTitle
		}
		if msg.refresh {
			cmds = append(cmds, m.refreshCmd())
		}
	case tickMsg:
		if m.settings.autoRefresh && m.ready && !m.refreshing && !m.inflight {
			m.refreshing = true
			cmds = append(cmds, m.refreshCmd())
		}
		cmds = append(cmds, tickEvery(m.settings.pollInterval))
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resize()
		m.renderPanes()
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		if m.launcherActive {
			m.launcherPulse = (m.launcherPulse + 1) % 24
		}
		cmds = append(cmds, cmd)
	case tea.KeyMsg:
		if key := msg.String(); key == "ctrl+c" {
			return m, tea.Quit
		}
		if m.startupErr != nil {
			if msg.String() == "q" || msg.String() == "esc" || msg.String() == "ctrl+c" {
				return m, tea.Quit
			}
			return m, nil
		}
		if m.launcherActive {
			switch msg.String() {
			case "up", "k":
				m.launcherIndex = (m.launcherIndex + len(m.launcherItems) - 1) % len(m.launcherItems)
			case "down", "j":
				m.launcherIndex = (m.launcherIndex + 1) % len(m.launcherItems)
			case "esc":
				m.launcherActive = false
				m.activeTab = tabChat
				m.input.Focus()
				m.statusLine = "launcher skipped · chat ready"
				m.renderPanes()
			case "q":
				return m, tea.Quit
			case "enter":
				switch m.launcherIndex {
				case 0:
					m.launcherActive = false
					m.activeTab = tabChat
					m.input.Focus()
					if m.ready {
						m.statusLine = "tri-chat ready"
					} else {
						m.statusLine = "starting tri-chat..."
					}
					m.renderPanes()
				case 1:
					m.launcherActive = false
					m.activeTab = tabReliability
					m.input.Blur()
					m.statusLine = "reliability panel"
					m.renderPanes()
				case 2:
					m.launcherActive = false
					m.activeTab = tabSettings
					m.input.Blur()
					m.statusLine = "settings panel"
					m.renderPanes()
				case 3:
					m.launcherActive = false
					m.activeTab = tabHelp
					m.input.Blur()
					m.statusLine = "help panel"
					m.renderPanes()
				case 4:
					return m, tea.Quit
				}
			}
			return m, tea.Batch(cmds...)
		}

		switch msg.String() {
		case "tab":
			m.activeTab = (m.activeTab + 1) % 4
			if m.activeTab == tabChat {
				m.input.Focus()
			} else {
				m.input.Blur()
			}
			m.renderPanes()
			return m, tea.Batch(cmds...)
		case "shift+tab":
			m.activeTab = (m.activeTab + 3) % 4
			if m.activeTab == tabChat {
				m.input.Focus()
			} else {
				m.input.Blur()
			}
			m.renderPanes()
			return m, tea.Batch(cmds...)
		}

		switch m.activeTab {
		case tabChat:
			switch msg.String() {
			case "enter":
				if m.inflight || !m.ready {
					return m, tea.Batch(cmds...)
				}
				raw := strings.TrimSpace(m.input.Value())
				if raw == "" {
					return m, tea.Batch(cmds...)
				}
				m.input.SetValue("")
				if strings.HasPrefix(raw, "/") {
					cmd := m.handleSlash(raw)
					if cmd != nil {
						m.inflight = true
						cmds = append(cmds, cmd)
					}
					return m, tea.Batch(cmds...)
				}
				m.inflight = true
				cmds = append(cmds, m.fanoutCmd(raw, m.settings.fanoutTarget))
				return m, tea.Batch(cmds...)
			case "pgup", "ctrl+b":
				m.timeline.LineUp(8)
				return m, tea.Batch(cmds...)
			case "pgdown", "ctrl+f":
				m.timeline.LineDown(8)
				return m, tea.Batch(cmds...)
			case "home":
				m.timeline.GotoTop()
				return m, tea.Batch(cmds...)
			case "end":
				m.timeline.GotoBottom()
				return m, tea.Batch(cmds...)
			}
			var cmd tea.Cmd
			m.input, cmd = m.input.Update(msg)
			cmds = append(cmds, cmd)
		case tabSettings:
			switch msg.String() {
			case "up", "k":
				m.settingsIndex = maxInt(0, m.settingsIndex-1)
			case "down", "j":
				m.settingsIndex = minInt(m.maxSettingsIndex(), m.settingsIndex+1)
			case "left", "h", "-":
				m.adjustSetting(-1)
			case "right", "l", "+":
				m.adjustSetting(1)
			}
			m.renderPanes()
		case tabReliability:
			switch msg.String() {
			case "pgup", "k":
				m.sidebar.LineUp(4)
			case "pgdown", "j":
				m.sidebar.LineDown(4)
			}
		}
	}
	return m, tea.Batch(cmds...)
}

func (m *model) handleSlash(raw string) tea.Cmd {
	parts := strings.Fields(strings.TrimSpace(raw))
	if len(parts) == 0 {
		return nil
	}
	cmd := strings.ToLower(parts[0])
	tail := parts[1:]
	switch cmd {
	case "/help":
		m.activeTab = tabHelp
		m.renderPanes()
		m.inflight = false
		return nil
	case "/quit", "/exit":
		m.inflight = false
		return tea.Quit
	case "/panel":
		return m.refreshCmd()
	case "/fanout":
		if len(tail) == 0 {
			m.inflight = false
			m.statusLine = "fanout target: " + m.settings.fanoutTarget
			return nil
		}
		target := strings.ToLower(strings.TrimSpace(tail[0]))
		if target != "all" && target != "codex" && target != "cursor" && target != "local-imprint" {
			m.inflight = false
			m.statusLine = "usage: /fanout all|codex|cursor|local-imprint"
			return nil
		}
		m.settings.fanoutTarget = target
		m.inflight = false
		m.statusLine = "fanout target set: " + target
		m.renderPanes()
		return nil
	case "/agent":
		if len(tail) < 2 {
			m.inflight = false
			m.statusLine = "usage: /agent <codex|cursor|local-imprint> <message>"
			return nil
		}
		target := strings.ToLower(strings.TrimSpace(tail[0]))
		if target != "codex" && target != "cursor" && target != "local-imprint" {
			m.inflight = false
			m.statusLine = "unknown agent: " + target
			return nil
		}
		prompt := strings.TrimSpace(strings.Join(tail[1:], " "))
		if prompt == "" {
			m.inflight = false
			m.statusLine = "usage: /agent <agent> <message>"
			return nil
		}
		return m.fanoutCmd(prompt, target)
	case "/thread":
		return m.threadCommandCmd(tail)
	case "/retry":
		action := "status"
		if len(tail) > 0 {
			action = strings.ToLower(tail[0])
		}
		if !validAction(action) {
			m.inflight = false
			m.statusLine = "usage: /retry status|start|stop|run_once"
			return nil
		}
		return m.daemonActionCmd("task.auto_retry", action)
	case "/retentiond":
		action := "status"
		if len(tail) > 0 {
			action = strings.ToLower(tail[0])
		}
		if !validAction(action) {
			m.inflight = false
			m.statusLine = "usage: /retentiond status|start|stop|run_once"
			return nil
		}
		return m.daemonActionCmd("trichat.auto_retention", action)
	case "/retention":
		days := 14
		apply := false
		allThreads := false
		if len(tail) > 0 {
			if parsed, err := strconv.Atoi(tail[0]); err == nil {
				days = parsed
			}
		}
		for _, token := range tail[1:] {
			normalized := strings.ToLower(strings.TrimSpace(token))
			if normalized == "apply" {
				apply = true
			}
			if normalized == "all" {
				allThreads = true
			}
		}
		return m.trichatRetentionCmd(maxInt(0, days), allThreads, apply)
	case "/execute":
		if len(tail) == 0 {
			m.inflight = false
			m.statusLine = "usage: /execute <agent> [objective]"
			return nil
		}
		agentID := tail[0]
		objective := strings.TrimSpace(strings.Join(tail[1:], " "))
		return m.executeCmd(agentID, objective)
	default:
		m.inflight = false
		m.statusLine = "unknown command: " + cmd
		return nil
	}
}

func validAction(action string) bool {
	switch action {
	case "status", "start", "stop", "run_once":
		return true
	default:
		return false
	}
}

func (m model) View() string {
	if m.startupErr != nil {
		errorPanel := m.theme.panel.
			Width(maxInt(20, m.width-4)).
			Render(
				m.theme.panelTitle.Render("TriChat TUI Startup Failed") + "\n\n" +
					m.theme.errorStatus.Render(m.startupErr.Error()) + "\n\n" +
					m.theme.helpText.Render("Press q or Ctrl+C to exit."),
			)
		return m.theme.root.Render(errorPanel)
	}
	if m.launcherActive {
		return m.theme.root.Render(m.renderLauncher())
	}

	header := m.renderHeader()
	content := m.renderContent()
	input := m.renderInput()
	footer := m.renderFooter()

	out := lipgloss.JoinVertical(lipgloss.Left, header, content, input, footer)
	return m.theme.root.Render(out)
}

func (m *model) renderLauncher() string {
	contentWidth := maxInt(48, minInt(100, m.width-4))
	if contentWidth <= 0 {
		contentWidth = 72
	}

	pulseOn := ((m.launcherPulse / 2) % 2) == 0
	titleStyle := m.theme.launcherTitle
	frameStyle := m.theme.launcherFrame
	if pulseOn {
		titleStyle = m.theme.launcherTitlePulse
		frameStyle = m.theme.launcherFrameAlt
	}

	innerWidth := clampInt(contentWidth-8, 34, 74)
	rule := "+" + strings.Repeat("-", innerWidth) + "+"
	headerA := "| " + padRight("TRI-CHAT ARCADE CONSOLE", innerWidth-2) + " |"
	headerB := "| " + padRight("one prompt -> three agents", innerWidth-2) + " |"

	statusLabel := "BOOTING"
	statusStyle := m.theme.launcherBoot
	statusDetail := "running startup pipeline: tool health -> thread open -> imprint bootstrap"
	if m.ready {
		statusLabel = "ONLINE"
		statusStyle = m.theme.launcherReady
		statusDetail = "anamnesis runtime synced. pick a pane or start chatting."
	} else if strings.TrimSpace(m.statusLine) != "" && !strings.EqualFold(strings.TrimSpace(m.statusLine), "starting...") {
		statusDetail = compactSingleLine(m.statusLine, 120)
	}
	bootLine := statusStyle.Render("["+statusLabel+"]") + " " + statusDetail

	var options strings.Builder
	for idx, item := range m.launcherItems {
		prefix := "   "
		if idx == m.launcherIndex {
			prefix = ">> "
		}
		line := fmt.Sprintf("%s%d. %s", prefix, idx+1, item)
		if idx == m.launcherIndex {
			options.WriteString(m.theme.launcherSelect.Render(line))
		} else {
			options.WriteString(m.theme.launcherOption.Render(line))
		}
		options.WriteString("\n")
	}

	art := []string{
		"    /\\_/\\        /\\_/\\        /\\_/\\",
		"   ( o.o )      ( o.o )      ( o.o )",
		"    > ^ <        > ^ <        > ^ <",
	}

	body := strings.Join([]string{
		titleStyle.Render("TriChat"),
		m.theme.launcherMuted.Render("Retro launcher for your three-agent terminal apartment"),
		"",
		m.theme.launcherAccent.Render(rule),
		m.theme.launcherAccent.Render(headerA),
		m.theme.launcherAccent.Render(headerB),
		m.theme.launcherAccent.Render(rule),
		"",
		m.theme.launcherAccent.Render(strings.Join(art, "\n")),
		"",
		m.spinner.View() + " " + bootLine,
		m.theme.launcherMuted.Render("Thread: " + nullCoalesce(m.threadID, "initializing...")),
		m.theme.launcherMuted.Render("Roster: codex | cursor | local-imprint"),
		"",
		strings.TrimRight(options.String(), "\n"),
		"",
		m.theme.launcherMuted.Render("Keys: up/down choose | enter launch | esc skip to chat | q quit"),
	}, "\n")
	body = applyScanlineOverlay(body, m.theme.launcherScanlineA, m.theme.launcherScanlineB)

	panel := frameStyle.Width(contentWidth).Render(body)
	return lipgloss.Place(
		maxInt(contentWidth+2, m.width-2),
		maxInt(16, m.height-2),
		lipgloss.Center,
		lipgloss.Center,
		panel,
	)
}

func padRight(text string, width int) string {
	if width <= 0 {
		return ""
	}
	if len(text) >= width {
		return text[:width]
	}
	return text + strings.Repeat(" ", width-len(text))
}

func applyScanlineOverlay(text string, lineA lipgloss.Style, lineB lipgloss.Style) string {
	lines := strings.Split(text, "\n")
	maxWidth := 0
	for _, line := range lines {
		maxWidth = maxInt(maxWidth, lipgloss.Width(line))
	}
	if maxWidth <= 0 {
		return text
	}
	out := make([]string, 0, len(lines))
	for idx, line := range lines {
		padded := line + strings.Repeat(" ", maxInt(0, maxWidth-lipgloss.Width(line)))
		if idx%2 == 0 {
			out = append(out, lineA.Render(padded))
		} else {
			out = append(out, lineB.Render(padded))
		}
	}
	return strings.Join(out, "\n")
}

func (m *model) renderHeader() string {
	tabs := []struct {
		id    tabID
		label string
	}{
		{tabChat, "Chat"},
		{tabReliability, "Reliability"},
		{tabSettings, "Settings"},
		{tabHelp, "Help"},
	}
	segments := make([]string, 0, len(tabs)+1)
	for _, tab := range tabs {
		style := m.theme.tabInactive
		if tab.id == m.activeTab {
			style = m.theme.tabActive
		}
		segments = append(segments, style.Render(tab.label))
	}
	threadMeta := fmt.Sprintf("Thread: %s", nullCoalesce(m.threadID, "n/a"))
	segments = append(segments, m.theme.helpText.Render(threadMeta))
	joined := lipgloss.JoinHorizontal(lipgloss.Left, segments...)
	return m.theme.header.Width(maxInt(20, m.width-4)).Render(joined)
}

func (m *model) renderContent() string {
	contentHeight := maxInt(8, m.height-12)
	contentWidth := maxInt(40, m.width-4)

	switch m.activeTab {
	case tabChat:
		leftWidth := int(float64(contentWidth) * 0.66)
		rightWidth := contentWidth - leftWidth - 1
		if rightWidth < 28 {
			rightWidth = 28
			leftWidth = contentWidth - rightWidth - 1
		}
		left := m.theme.panel.Width(leftWidth).Height(contentHeight).Render(
			m.theme.panelTitle.Render("Live Timeline") + "\n" + m.timeline.View(),
		)
		right := m.theme.panel.Width(rightWidth).Height(contentHeight).Render(
			m.theme.panelTitle.Render("Reliability Sidebar") + "\n" + m.sidebar.View(),
		)
		return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
	case tabReliability:
		panel := m.theme.panel.Width(contentWidth).Height(contentHeight)
		return panel.Render(m.theme.panelTitle.Render("Reliability Detail") + "\n" + m.renderReliabilityDetail())
	case tabSettings:
		panel := m.theme.panel.Width(contentWidth).Height(contentHeight)
		return panel.Render(m.theme.panelTitle.Render("Runtime Settings") + "\n" + m.renderSettings())
	case tabHelp:
		panel := m.theme.panel.Width(contentWidth).Height(contentHeight)
		return panel.Render(m.theme.panelTitle.Render("TriChat TUI Help") + "\n" + m.renderHelp())
	default:
		return ""
	}
}

func (m *model) renderInput() string {
	contentWidth := maxInt(40, m.width-4)
	if m.activeTab != tabChat {
		return m.theme.inputPanel.Width(contentWidth).Render(m.theme.helpText.Render("Input disabled outside Chat tab. Press Tab to return."))
	}
	inputView := m.input.View()
	if m.inflight {
		inputView = m.spinner.View() + " processing... " + inputView
	}
	return m.theme.inputPanel.Width(contentWidth).Render(inputView)
}

func (m *model) renderFooter() string {
	contentWidth := maxInt(40, m.width-4)
	statusStyle := m.theme.status
	if strings.Contains(strings.ToLower(m.statusLine), "failed") || strings.Contains(strings.ToLower(m.statusLine), "error") {
		statusStyle = m.theme.errorStatus
	}
	line := statusStyle.Render(compactSingleLine(m.statusLine, 180))
	hints := m.theme.helpText.Render("Keys: Tab switch view · Enter send · PgUp/PgDn scroll · Ctrl+C quit")
	return m.theme.footer.Width(contentWidth).Render(line + "\n" + hints)
}

func (m *model) renderPanes() {
	contentHeight := maxInt(8, m.height-12)
	contentWidth := maxInt(40, m.width-4)
	leftWidth := int(float64(contentWidth) * 0.66)
	rightWidth := contentWidth - leftWidth - 1
	if rightWidth < 28 {
		rightWidth = 28
		leftWidth = contentWidth - rightWidth - 1
	}

	m.timeline.Width = maxInt(20, leftWidth-4)
	m.timeline.Height = maxInt(5, contentHeight-3)
	m.sidebar.Width = maxInt(20, rightWidth-4)
	m.sidebar.Height = maxInt(5, contentHeight-3)

	m.timeline.SetContent(m.renderTimeline())
	m.timeline.GotoBottom()
	m.sidebar.SetContent(m.renderSidebar())
}

func (m *model) resize() {
	contentWidth := maxInt(40, m.width-4)
	m.input.Width = maxInt(20, contentWidth-6)
}

func (m *model) renderTimeline() string {
	if len(m.messages) == 0 {
		return "No messages yet. Send a prompt to start tri-agent fanout."
	}
	var b strings.Builder
	for _, msg := range m.messages {
		timestamp := shortTime(msg.CreatedAt)
		agentLabel := msg.AgentID
		if strings.TrimSpace(agentLabel) == "" {
			agentLabel = msg.Role
		}
		style, ok := m.theme.chatAgent[agentLabel]
		if !ok {
			style = m.theme.chatAgent["system"]
		}
		header := fmt.Sprintf("%s [%s/%s]", timestamp, agentLabel, msg.Role)
		b.WriteString(style.Render(header))
		b.WriteString("\n")
		b.WriteString(wrapText(msg.Content, maxInt(24, m.timeline.Width-2)))
		b.WriteString("\n\n")
	}
	return strings.TrimSpace(b.String())
}

func (m *model) renderSidebar() string {
	r := m.reliability
	counts := r.taskSummary.Counts
	pending := counts["pending"]
	running := counts["running"]
	failed := counts["failed"]
	completed := counts["completed"]

	var b strings.Builder
	b.WriteString(fmt.Sprintf("Tasks  pending=%d running=%d failed=%d completed=%d\n", pending, running, failed, completed))
	b.WriteString(fmt.Sprintf("Daemons  retry=%s squish=%s retention=%s\n",
		onOff(r.taskAutoRetry.Running), onOff(r.transcriptSquish.Running), onOff(r.triRetention.Running)))
	b.WriteString(fmt.Sprintf("TriChat  threads=%d messages=%d\n",
		r.triSummary.ThreadCounts.Total, r.triSummary.MessageCount))
	b.WriteString(fmt.Sprintf("Adapters  open=%d/%d trips=%d degraded=%d/%d\n",
		r.adapterTelemetry.Summary.OpenChannels,
		r.adapterTelemetry.Summary.TotalChannels,
		r.adapterTelemetry.Summary.TotalTrips,
		r.adapterTelemetry.Summary.TotalDegradedTurns,
		r.adapterTelemetry.Summary.TotalTurns,
	))
	if strings.TrimSpace(r.adapterTelemetry.Summary.NewestTripOpenedAt) != "" {
		b.WriteString("Last trip  " + r.adapterTelemetry.Summary.NewestTripOpenedAt + "\n")
	}

	if len(r.taskSummary.Running) > 0 {
		b.WriteString("\nActive leases:\n")
		for _, row := range r.taskSummary.Running {
			b.WriteString("- " + row.TaskID + " owner=" + nullCoalesce(row.OwnerID, "none") + "\n")
		}
	}

	if len(r.adapterTelemetry.LastOpenEvents) > 0 {
		b.WriteString("\nRecent trip events:\n")
		limit := minInt(3, len(r.adapterTelemetry.LastOpenEvents))
		for i := 0; i < limit; i++ {
			event := r.adapterTelemetry.LastOpenEvents[i]
			b.WriteString(fmt.Sprintf("- %s %s/%s %s\n",
				shortTime(event.CreatedAt),
				event.AgentID,
				event.Channel,
				compactSingleLine(event.ErrorText, 60),
			))
		}
	}
	return strings.TrimSpace(b.String())
}

func (m *model) renderReliabilityDetail() string {
	var b strings.Builder
	b.WriteString(m.renderSidebar())
	b.WriteString("\n\nRecent adapter events:\n")
	if len(m.reliability.adapterTelemetry.RecentEvents) == 0 {
		b.WriteString("(none)")
	} else {
		for _, event := range m.reliability.adapterTelemetry.RecentEvents {
			line := fmt.Sprintf("- %s %s/%s %s",
				shortTime(event.CreatedAt),
				event.AgentID,
				event.Channel,
				event.EventType,
			)
			if strings.TrimSpace(event.ErrorText) != "" {
				line += " :: " + compactSingleLine(event.ErrorText, 90)
			}
			b.WriteString(line + "\n")
		}
	}
	return strings.TrimSpace(b.String())
}

func (m *model) maxSettingsIndex() int {
	return 8
}

func (m *model) adjustSetting(delta int) {
	if delta == 0 {
		return
	}
	switch m.settingsIndex {
	case 0:
		options := []string{"all", "codex", "cursor", "local-imprint"}
		m.settings.fanoutTarget = cycleString(options, m.settings.fanoutTarget, delta)
	case 1:
		options := []string{"open", "allowlist", "approval"}
		m.settings.executeGateMode = cycleString(options, m.settings.executeGateMode, delta)
	case 2:
		m.settings.pollInterval = time.Duration(clampInt(int(m.settings.pollInterval.Seconds())+delta, 1, 60)) * time.Second
	case 3:
		m.settings.modelTimeoutSeconds = clampInt(m.settings.modelTimeoutSeconds+delta, 1, 120)
	case 4:
		m.settings.bridgeTimeoutSeconds = clampInt(m.settings.bridgeTimeoutSeconds+delta, 1, 120)
	case 5:
		m.settings.adapterFailoverTimeoutSecond = clampInt(m.settings.adapterFailoverTimeoutSecond+delta, 1, 120)
	case 6:
		m.settings.adapterCircuitThreshold = clampInt(m.settings.adapterCircuitThreshold+delta, 1, 10)
	case 7:
		m.settings.adapterCircuitRecoverySecond = clampInt(m.settings.adapterCircuitRecoverySecond+delta, 1, 600)
	case 8:
		if delta != 0 {
			m.settings.autoRefresh = !m.settings.autoRefresh
		}
	}
	m.renderPanes()
	m.statusLine = "settings updated"
}

func (m *model) renderSettings() string {
	rows := []struct {
		label string
		value string
		help  string
	}{
		{"Fanout Target", m.settings.fanoutTarget, "all/codex/cursor/local-imprint"},
		{"Execute Gate", m.settings.executeGateMode, "open/allowlist/approval"},
		{"Poll Interval", fmt.Sprintf("%ds", int(m.settings.pollInterval.Seconds())), "sidebar and timeline refresh interval"},
		{"Model Timeout", fmt.Sprintf("%ds", m.settings.modelTimeoutSeconds), "per Ollama request timeout"},
		{"Bridge Timeout", fmt.Sprintf("%ds", m.settings.bridgeTimeoutSeconds), "per command-adapter timeout"},
		{"Failover Timeout", fmt.Sprintf("%ds", m.settings.adapterFailoverTimeoutSecond), "per-agent turn budget"},
		{"Circuit Threshold", strconv.Itoa(m.settings.adapterCircuitThreshold), "failures before channel opens"},
		{"Circuit Recovery", fmt.Sprintf("%ds", m.settings.adapterCircuitRecoverySecond), "recovery window before retry"},
		{"Auto Refresh", onOff(m.settings.autoRefresh), "periodic state refresh"},
	}
	var b strings.Builder
	b.WriteString(m.theme.helpText.Render("Use ↑/↓ to select and ←/→ (or -/+) to change values."))
	b.WriteString("\n\n")
	for i, row := range rows {
		labelStyle := m.theme.settingKey
		valueStyle := m.theme.settingValue
		prefix := "  "
		if i == m.settingsIndex {
			labelStyle = m.theme.settingPick
			valueStyle = m.theme.settingPick
			prefix = "▶ "
		}
		b.WriteString(prefix + labelStyle.Render(fmt.Sprintf("%-18s", row.label)) + " " + valueStyle.Render(row.value) + "\n")
		b.WriteString("   " + m.theme.helpText.Render(row.help) + "\n")
	}
	b.WriteString("\nCurrent transport: " + m.cfg.transport + " · model: " + m.settings.model)
	return strings.TrimSpace(b.String())
}

func (m *model) renderHelp() string {
	lines := []string{
		"Core Keys",
		"- Launcher: Up/Down select, Enter launch, Esc skip to chat",
		"- Tab / Shift+Tab: switch views",
		"- Enter: send prompt (Chat tab)",
		"- PgUp/PgDn: scroll timeline",
		"- Ctrl+C: quit",
		"",
		"Slash Commands",
		"- /fanout all|codex|cursor|local-imprint",
		"- /agent <agent> <message>",
		"- /thread list [limit]",
		"- /thread new [title]",
		"- /thread use <thread_id>",
		"- /thread archive [thread_id]",
		"- /retry status|start|stop|run_once",
		"- /retentiond status|start|stop|run_once",
		"- /retention [days] [apply] [all]",
		"- /execute <agent> [objective]",
		"- /panel",
		"- /help",
		"- /quit",
		"",
		"Visual Theme",
		"- Neon cotton-candy palette (pink/blue/mint)",
		"- Framed split panes with live timeline and reliability telemetry",
		"- Bridge wrappers auto-load from ./bridges for codex/cursor (override with --codex-command / --cursor-command)",
	}
	return m.theme.helpText.Render(strings.Join(lines, "\n"))
}

func (m *model) appendLog(line string) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return
	}
	m.logs = append(m.logs, fmt.Sprintf("%s %s", time.Now().Format("15:04:05"), compactSingleLine(trimmed, 220)))
	if len(m.logs) > 50 {
		m.logs = m.logs[len(m.logs)-50:]
	}
}

func (m *model) logError(err error) {
	if err == nil {
		return
	}
	m.appendLog("error: " + err.Error())
	m.statusLine = "error: " + compactSingleLine(err.Error(), 160)
}

func parseFlags() appConfig {
	cwd, _ := os.Getwd()
	repoRootDefault := cwd
	if repoRootDefault == "" {
		repoRootDefault = "."
	}

	cfg := appConfig{}
	flag.StringVar(&cfg.repoRoot, "repo-root", repoRootDefault, "Repository root path")
	flag.StringVar(&cfg.threadID, "thread-id", "", "Existing tri-chat thread id")
	flag.StringVar(&cfg.threadTitle, "thread-title", defaultThreadTitle, "Thread title")
	flag.BoolVar(&cfg.resumeLatest, "resume-latest", true, "Resume most recent active thread")
	flag.StringVar(&cfg.transport, "transport", envOr("TRICHAT_MCP_TRANSPORT", "stdio"), "MCP transport (stdio|http)")
	flag.StringVar(&cfg.url, "url", envOr("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"), "MCP HTTP URL")
	flag.StringVar(&cfg.origin, "origin", envOr("TRICHAT_MCP_ORIGIN", "http://127.0.0.1"), "Origin header for MCP HTTP")
	flag.StringVar(&cfg.stdioCommand, "stdio-command", envOr("TRICHAT_MCP_STDIO_COMMAND", "node"), "stdio command for MCP helper")
	flag.StringVar(&cfg.stdioArgs, "stdio-args", envOr("TRICHAT_MCP_STDIO_ARGS", "dist/server.js"), "stdio args for MCP helper")
	flag.StringVar(&cfg.model, "model", envOr("TRICHAT_OLLAMA_MODEL", defaultModel), "Default Ollama model")
	flag.StringVar(&cfg.codexCommand, "codex-command", envOr("TRICHAT_CODEX_CMD", ""), "Optional command adapter for codex (auto-default: ./bridges/codex_bridge.py)")
	flag.StringVar(&cfg.cursorCommand, "cursor-command", envOr("TRICHAT_CURSOR_CMD", ""), "Optional command adapter for cursor (auto-default: ./bridges/cursor_bridge.py)")
	flag.StringVar(&cfg.imprintCommand, "imprint-command", envOr("TRICHAT_IMPRINT_CMD", ""), "Optional command adapter for local-imprint (auto-default: ./bridges/local-imprint_bridge.py if present)")
	flag.IntVar(&cfg.modelTimeoutSeconds, "model-timeout", envOrInt("TRICHAT_MODEL_TIMEOUT", 20), "Per-request Ollama timeout seconds")
	flag.IntVar(&cfg.bridgeTimeoutSeconds, "bridge-timeout", envOrInt("TRICHAT_BRIDGE_TIMEOUT", 45), "Bridge command timeout seconds")
	flag.IntVar(&cfg.adapterFailoverTimeoutSecond, "adapter-failover-timeout", envOrInt("TRICHAT_ADAPTER_FAILOVER_TIMEOUT", 18), "Per-agent failover timeout seconds")
	flag.IntVar(&cfg.adapterCircuitThreshold, "adapter-circuit-threshold", envOrInt("TRICHAT_ADAPTER_CIRCUIT_THRESHOLD", 2), "Consecutive failures before opening circuit")
	flag.IntVar(&cfg.adapterCircuitRecoverySecond, "adapter-circuit-recovery-seconds", envOrInt("TRICHAT_ADAPTER_CIRCUIT_RECOVERY_SECONDS", 45), "Circuit recovery window seconds")
	flag.StringVar(&cfg.executeGateMode, "execute-gate-mode", envOr("TRICHAT_EXECUTE_GATE_MODE", "open"), "execute gate mode (open|allowlist|approval)")
	allowAgents := envOr("TRICHAT_EXECUTE_ALLOW_AGENTS", "codex,cursor,local-imprint")
	flag.StringVar(&allowAgents, "execute-allow-agents", allowAgents, "Comma-separated execute allowlist")
	flag.StringVar(&cfg.executeApprovalPhrase, "execute-approval-phrase", envOr("TRICHAT_EXECUTE_APPROVAL_PHRASE", "approve"), "Approval phrase for execute gate mode=approval")
	pollIntervalSeconds := envOrInt("TRICHAT_TUI_POLL_INTERVAL", 2)
	flag.IntVar(&pollIntervalSeconds, "poll-interval", pollIntervalSeconds, "Refresh interval seconds")
	launcherDefault := envOrBool("TRICHAT_TUI_LAUNCHER", true)
	flag.BoolVar(&cfg.launcher, "launcher", launcherDefault, "Show startup launcher menu")
	noLauncher := envOrBool("TRICHAT_TUI_NO_LAUNCHER", false)
	flag.BoolVar(&noLauncher, "no-launcher", noLauncher, "Disable launcher and open chat input immediately")
	flag.BoolVar(&cfg.altScreen, "alt-screen", true, "Use alternate screen buffer")
	flag.StringVar(&cfg.sessionSeed, "session-seed", "", "Optional idempotency seed")
	flag.Parse()

	resolvedRoot, _ := filepath.Abs(cfg.repoRoot)
	cfg.repoRoot = resolvedRoot
	cfg.transport = strings.ToLower(strings.TrimSpace(cfg.transport))
	if cfg.transport != "http" {
		cfg.transport = "stdio"
	}
	cfg.modelTimeoutSeconds = clampInt(cfg.modelTimeoutSeconds, 1, 120)
	cfg.bridgeTimeoutSeconds = clampInt(cfg.bridgeTimeoutSeconds, 1, 120)
	cfg.adapterFailoverTimeoutSecond = clampInt(cfg.adapterFailoverTimeoutSecond, 1, 120)
	cfg.adapterCircuitThreshold = clampInt(cfg.adapterCircuitThreshold, 1, 10)
	cfg.adapterCircuitRecoverySecond = clampInt(cfg.adapterCircuitRecoverySecond, 1, 600)
	cfg.pollInterval = time.Duration(clampInt(pollIntervalSeconds, 1, 60)) * time.Second
	if noLauncher {
		cfg.launcher = false
	}
	cfg.executeGateMode = normalizeGateMode(cfg.executeGateMode)
	cfg.executeAllowAgents = parseAllowlist(allowAgents)
	if strings.TrimSpace(cfg.codexCommand) == "" {
		cfg.codexCommand = autoBridgeCommand(cfg.repoRoot, "codex")
	}
	if strings.TrimSpace(cfg.cursorCommand) == "" {
		cfg.cursorCommand = autoBridgeCommand(cfg.repoRoot, "cursor")
	}
	if strings.TrimSpace(cfg.imprintCommand) == "" {
		cfg.imprintCommand = autoBridgeCommand(cfg.repoRoot, "local-imprint")
	}
	if cfg.executeApprovalPhrase == "" {
		cfg.executeApprovalPhrase = "approve"
	}
	if strings.TrimSpace(cfg.sessionSeed) == "" {
		cfg.sessionSeed = fmt.Sprintf("trichat-tui-%d", time.Now().Unix())
	}
	return cfg
}

func normalizeGateMode(mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	switch normalized {
	case "allowlist", "approval", "open":
		return normalized
	default:
		return "open"
	}
}

func parseAllowlist(raw string) map[string]bool {
	parts := strings.Split(raw, ",")
	out := map[string]bool{}
	for _, part := range parts {
		value := strings.TrimSpace(strings.ToLower(part))
		if value != "" {
			out[value] = true
		}
	}
	if len(out) == 0 {
		out["codex"] = true
		out["cursor"] = true
		out["local-imprint"] = true
	}
	return out
}

func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envOrInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envOrBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func autoBridgeCommand(repoRoot, agentID string) string {
	scriptPath := filepath.Join(repoRoot, "bridges", agentID+"_bridge.py")
	if _, err := os.Stat(scriptPath); err != nil {
		return ""
	}
	pythonBin := strings.TrimSpace(os.Getenv("TRICHAT_BRIDGE_PYTHON"))
	if pythonBin == "" {
		pythonBin = "python3"
	}
	return shellQuote(pythonBin) + " " + shellQuote(scriptPath)
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if !strings.ContainsAny(value, " \t\n'\"\\$`") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func splitCommand(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	args := make([]string, 0, 8)
	var current strings.Builder
	inSingle := false
	inDouble := false
	escaped := false
	flush := func() {
		if current.Len() == 0 {
			return
		}
		args = append(args, current.String())
		current.Reset()
	}
	for _, r := range trimmed {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case r == '\\' && !inSingle:
			escaped = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
		case r == '"' && !inSingle:
			inDouble = !inDouble
		case unicode.IsSpace(r) && !inSingle && !inDouble:
			flush()
		default:
			current.WriteRune(r)
		}
	}
	if escaped {
		current.WriteRune('\\')
	}
	flush()
	if inSingle || inDouble {
		// Fallback for malformed quoted strings.
		return strings.Fields(trimmed)
	}
	return args
}

func shortTime(iso string) string {
	parsed, err := parseISO(iso)
	if err != nil {
		return "--:--:--"
	}
	return parsed.Local().Format("15:04:05")
}

func parseISO(value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, errors.New("empty")
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err == nil {
		return parsed, nil
	}
	parsed, err = time.Parse(time.RFC3339Nano, trimmed)
	if err == nil {
		return parsed, nil
	}
	return time.Time{}, err
}

func wrapText(text string, width int) string {
	if width <= 0 {
		return text
	}
	lines := strings.Split(text, "\n")
	wrapped := make([]string, 0, len(lines))
	for _, line := range lines {
		words := strings.Fields(line)
		if len(words) == 0 {
			wrapped = append(wrapped, "")
			continue
		}
		current := words[0]
		for _, word := range words[1:] {
			if len(current)+1+len(word) <= width {
				current += " " + word
				continue
			}
			wrapped = append(wrapped, current)
			current = word
		}
		wrapped = append(wrapped, current)
	}
	return strings.Join(wrapped, "\n")
}

func truncate(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(text) <= limit {
		return text
	}
	if limit <= 3 {
		return text[:limit]
	}
	return text[:limit-3] + "..."
}

func compactSingleLine(text string, limit int) string {
	compact := strings.Join(strings.Fields(text), " ")
	return truncate(compact, limit)
}

func cycleString(options []string, current string, delta int) string {
	if len(options) == 0 {
		return current
	}
	idx := 0
	for i, option := range options {
		if option == current {
			idx = i
			break
		}
	}
	idx = (idx + delta) % len(options)
	if idx < 0 {
		idx += len(options)
	}
	return options[idx]
}

func onOff(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

func nullCoalesce(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func epochOrNil(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return float64(t.Unix()) + float64(t.Nanosecond())/1e9
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func ternary[T any](condition bool, whenTrue T, whenFalse T) T {
	if condition {
		return whenTrue
	}
	return whenFalse
}

func main() {
	cfg := parseFlags()
	if _, err := os.Stat(filepath.Join(cfg.repoRoot, "scripts", "mcp_tool_call.mjs")); err != nil {
		fmt.Fprintf(os.Stderr, "missing scripts/mcp_tool_call.mjs in repo root %s\n", cfg.repoRoot)
		os.Exit(1)
	}
	p := tea.NewProgram(newModel(cfg), tea.WithMouseCellMotion())
	if cfg.altScreen {
		p = tea.NewProgram(newModel(cfg), tea.WithAltScreen(), tea.WithMouseCellMotion())
	}
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "trichat-tui fatal error: %v\n", err)
		os.Exit(1)
	}
}
