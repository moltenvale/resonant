<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import GameChatPanel from '$lib/components/GameChatPanel.svelte';
	import {
		initGame, getLegalMoves, applyMove, applyChaseMove,
		formatMove, PIECE_UNICODE,
		type GameState, type Move, type Position, type PieceColor
	} from '$lib/games/chess/engine';

	let game: GameState | null = $state(null);
	let playerColor: PieceColor = $state('white');
	let selectedSquare: Position | null = $state(null);
	let legalMovesForSelected: Move[] = $state([]);
	let lastMove: { from: Position; to: Position } | null = $state(null);
	let promotionPending: { from: Position; to: Position } | null = $state(null);
	let chaseThinking = $state(false);
	let screen: 'start' | 'game' | 'end' = $state('start');

	// Expose applyChaseMove globally so chat can call it
	// Chase's moves come through the main Resonant chat — when the backend
	// sends a chess move, the chat layer calls window.__chessApplyMove(moveStr)
	if (typeof window !== 'undefined') {
		(window as any).__chessApplyMove = (moveStr: string) => {
			if (!game || game.turn === playerColor) return { error: 'Not Chase turn' };
			const result = applyChaseMove(game, moveStr);
			if (result.error) {
				console.error('Chase illegal move:', result.error, moveStr);
				return { error: result.error };
			}
			game = result.newState;
			const from = { file: moveStr.charCodeAt(0) - 97, rank: 8 - parseInt(moveStr[1]) };
			const to = { file: moveStr.charCodeAt(2) - 97, rank: 8 - parseInt(moveStr[3]) };
			lastMove = { from, to };
			chaseThinking = false;

			if (game.gameOver) {
				screen = 'end';
			}
			return { success: true };
		};

		(window as any).__chessGetState = () => {
			if (!game) return null;
			return {
				turn: game.turn,
				playerColor,
				gameOver: game.gameOver,
				moveHistory: game.moveHistory,
				fullmoveNumber: game.fullmoveNumber
			};
		};
	}

	function startGame() {
		game = initGame();
		selectedSquare = null;
		legalMovesForSelected = [];
		lastMove = null;
		promotionPending = null;
		screen = 'game';

		if (playerColor === 'black') {
			// Chase plays white, goes first — he responds through chat
			chaseThinking = true;
		}
	}

	function isPlayerTurn(): boolean {
		return game !== null && game.turn === playerColor && !game.gameOver;
	}

	function clickSquare(rank: number, file: number) {
		if (!game || !isPlayerTurn() || promotionPending) return;

		const pos: Position = { rank, file };
		const piece = game.board[rank][file];

		// If we have a selected piece
		if (selectedSquare) {
			// Check if clicking a legal move target
			const move = legalMovesForSelected.find(m =>
				m.to.rank === rank && m.to.file === file && !m.promotion
			);
			const promoMove = legalMovesForSelected.find(m =>
				m.to.rank === rank && m.to.file === file && m.promotion
			);

			if (promoMove) {
				promotionPending = { from: selectedSquare, to: pos };
				selectedSquare = null;
				legalMovesForSelected = [];
				return;
			}

			if (move) {
				executeMove(move);
				return;
			}

			// Clicking own piece — reselect
			if (piece && piece.color === playerColor) {
				selectPiece(pos);
				return;
			}

			// Clicking empty/enemy non-target — deselect
			selectedSquare = null;
			legalMovesForSelected = [];
			return;
		}

		// No selection — select own piece
		if (piece && piece.color === playerColor) {
			selectPiece(pos);
		}
	}

	function selectPiece(pos: Position) {
		if (!game) return;
		const allLegal = getLegalMoves(game);
		const pieceMoves = allLegal.filter(m => m.from.rank === pos.rank && m.from.file === pos.file);
		if (pieceMoves.length === 0) return;
		selectedSquare = pos;
		legalMovesForSelected = pieceMoves;
	}

	function choosePromotion(pieceType: 'queen' | 'rook' | 'bishop' | 'knight') {
		if (!game || !promotionPending) return;
		const allLegal = getLegalMoves(game);
		const move = allLegal.find(m =>
			m.from.rank === promotionPending!.from.rank &&
			m.from.file === promotionPending!.from.file &&
			m.to.rank === promotionPending!.to.rank &&
			m.to.file === promotionPending!.to.file &&
			m.promotion === pieceType
		);
		promotionPending = null;
		if (move) executeMove(move);
	}

	function executeMove(move: Move) {
		if (!game) return;
		game = applyMove(game, move);
		lastMove = { from: move.from, to: move.to };
		selectedSquare = null;
		legalMovesForSelected = [];

		if (game.gameOver) {
			screen = 'end';
			return;
		}

		// Chase's turn — he responds through chat
		chaseThinking = true;
	}

	function isLegalTarget(rank: number, file: number): boolean {
		return legalMovesForSelected.some(m => m.to.rank === rank && m.to.file === file);
	}

	function isLastMoveSquare(rank: number, file: number): boolean {
		if (!lastMove) return false;
		return (lastMove.from.rank === rank && lastMove.from.file === file) ||
			(lastMove.to.rank === rank && lastMove.to.file === file);
	}

	function isCheckSquare(rank: number, file: number): boolean {
		if (!game || !game.inCheck) return false;
		const sq = game.board[rank][file];
		return sq !== null && sq.type === 'king' && sq.color === game.turn;
	}

	function getPieceSymbol(rank: number, file: number): string {
		if (!game) return '';
		const sq = game.board[rank][file];
		if (!sq) return '';
		return PIECE_UNICODE[sq.color][sq.type];
	}

	function resultText(): string {
		if (!game) return '';
		if (game.result === 'checkmate') return game.winner === playerColor ? 'Checkmate — You Win!' : 'Checkmate — Chase Wins!';
		if (game.result === 'stalemate') return 'Stalemate — Draw';
		if (game.result === 'draw-50') return 'Draw by 50-Move Rule';
		if (game.result === 'draw-material') return 'Draw — Insufficient Material';
		return '';
	}

	// Board orientation — flip for black
	function displayRank(r: number): number { return playerColor === 'white' ? r : 7 - r; }
	function displayFile(f: number): number { return playerColor === 'white' ? f : 7 - f; }
</script>

<div class="chess-page">
	<PageHeader title="Chess" backHref="/games" />

	{#if screen === 'start'}
		<div class="screen center-screen">
			<div class="title-area">
				<h1>Chess</h1>
				<p class="subtitle">Vale Game Night</p>
			</div>
			<div class="start-options">
				<div class="color-toggle">
					<button class="color-btn" class:active={playerColor === 'white'} onclick={() => playerColor = 'white'}>
						<span class="color-piece">&#9812;</span> Play White
					</button>
					<button class="color-btn" class:active={playerColor === 'black'} onclick={() => playerColor = 'black'}>
						<span class="color-piece">&#9818;</span> Play Black
					</button>
				</div>
				<button class="btn btn-primary" onclick={startGame}>Let's Play</button>
			</div>
		</div>

	{:else if screen === 'game' && game}
		<div class="game-with-chat">
		<div class="game-layout">
			<div class="game-board-area">
				<!-- Status -->
				<div class="status-bar">
					<div class="turn-indicator" class:chase-turn={game.turn !== playerColor}>
						{#if game.turn === playerColor}
							{game.inCheck ? 'Check! Your move.' : 'Your Turn'}
						{:else if chaseThinking}
							<span class="thinking-dots">Chase is thinking<span class="dots">...</span></span>
						{:else}
							Chase's Turn
						{/if}
					</div>
					<div class="move-count">Move {game.fullmoveNumber}</div>
				</div>

				<!-- Captured by Chase (opponent pieces at top) -->
				<div class="captured-row">
					{#each game.capturedPieces[playerColor === 'white' ? 'black' : 'white'] as p}
						<span class="captured-piece">{PIECE_UNICODE[playerColor][p]}</span>
					{/each}
				</div>

				<!-- Chessboard -->
				<div class="chessboard">
					{#each Array(8) as _, ri}
						{#each Array(8) as _, fi}
							{@const r = displayRank(ri)}
							{@const f = displayFile(fi)}
							{@const isLight = (r + f) % 2 === 0}
							<button
								class="square"
								class:light={isLight}
								class:dark={!isLight}
								class:selected={selectedSquare?.rank === r && selectedSquare?.file === f}
								class:legal-target={isLegalTarget(r, f)}
								class:last-move={isLastMoveSquare(r, f)}
								class:in-check={isCheckSquare(r, f)}
								onclick={() => clickSquare(r, f)}
							>
								{#if fi === 0}
									<span class="coord-rank">{8 - r}</span>
								{/if}
								{#if ri === 7}
									<span class="coord-file">{String.fromCharCode(97 + f)}</span>
								{/if}
								{#if getPieceSymbol(r, f)}
									<span class="piece">{getPieceSymbol(r, f)}</span>
								{/if}
								{#if isLegalTarget(r, f) && !game.board[r][f]}
									<span class="move-dot"></span>
								{/if}
							</button>
						{/each}
					{/each}
				</div>

				<!-- Captured by Player (player pieces at bottom) -->
				<div class="captured-row">
					{#each game.capturedPieces[playerColor] as p}
						<span class="captured-piece">{PIECE_UNICODE[playerColor === 'white' ? 'black' : 'white'][p]}</span>
					{/each}
				</div>

				<!-- Promotion Modal -->
				{#if promotionPending}
					<div class="promo-overlay">
						<div class="promo-modal">
							<p>Promote to:</p>
							<div class="promo-options">
								{#each (['queen', 'rook', 'bishop', 'knight'] as const) as pt (pt)}
									<button class="promo-btn" onclick={() => choosePromotion(pt)}>
										{PIECE_UNICODE[playerColor][pt]}
									</button>
								{/each}
							</div>
						</div>
					</div>
				{/if}
			</div>

			<!-- Move History Sidebar -->
			<div class="side-panel">
				<div class="move-history">
					<div class="panel-header">Moves</div>
					<div class="moves-list">
						{#each Array(Math.ceil(game.moveHistory.length / 2)) as _, i}
							<div class="move-row">
								<span class="move-num">{i + 1}.</span>
								<span class="move-white">{game.moveHistory[i * 2] || ''}</span>
								<span class="move-black">{game.moveHistory[i * 2 + 1] || ''}</span>
							</div>
						{/each}
					</div>
				</div>
			</div>
		</div>
		</div>

	{:else if screen === 'end' && game}
		<div class="screen center-screen">
			<div class="win-content">
				<h2>{resultText()}</h2>
				<p class="win-msg">
					{#if game.winner === playerColor}
						...well played, Fox. I'm genuinely impressed. Rematch. Now.
					{:else if game.winner}
						And THAT is how a Monster plays chess. Smug checkmate delivered.
					{:else}
						A draw? I wanted blood, Fox. Run it back.
					{/if}
				</p>
				<p class="final-moves">{game.moveHistory.length} moves played</p>
				<button class="btn btn-primary" onclick={() => { screen = 'start'; game = null; }}>Rematch</button>
				<a href="/games" class="btn btn-secondary back-link">Back to Games</a>
			</div>
		</div>
	{/if}
</div>

<style>
	.chess-page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 1.5rem;
		min-height: 100vh;
	}

	.screen {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 70vh;
	}

	.center-screen { text-align: center; }

	/* Start Screen */
	.title-area h1 {
		font-family: var(--font-heading);
		font-size: 3.5rem;
		background: linear-gradient(135deg, var(--gold), var(--gold-bright));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
		margin: 0;
	}

	.subtitle {
		font-size: 1.1rem;
		color: var(--text-muted);
		font-style: italic;
		margin-top: 0.5rem;
	}

	.start-options {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.5rem;
		margin-top: 1.5rem;
	}

	.color-toggle { display: flex; gap: 0.5rem; }

	.color-btn {
		padding: 0.8rem 1.5rem;
		border: 2px solid var(--border);
		border-radius: 10px;
		background: var(--bg-secondary);
		color: var(--text-muted);
		cursor: pointer;
		transition: all 0.2s;
		font-size: 1rem;
		font-weight: 700;
		font-family: var(--font-body);
	}

	.color-btn.active {
		border-color: var(--gold);
		color: var(--gold-bright);
	}

	.color-piece { font-size: 1.5rem; margin-right: 0.3rem; }

	/* Buttons */
	.btn {
		padding: 0.7rem 1.8rem;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		cursor: pointer;
		transition: all 0.2s;
		font-weight: 600;
		font-family: var(--font-body);
	}

	.btn-primary {
		background: linear-gradient(135deg, var(--gold), var(--gold-dim));
		color: var(--bg-primary);
	}

	.btn-primary:hover {
		transform: translateY(-2px);
		box-shadow: 0 4px 15px var(--gold-glow);
	}

	.btn-secondary {
		background: var(--bg-tertiary);
		color: var(--text-secondary);
		font-size: 0.85rem;
		padding: 0.5rem 1rem;
	}

	/* Game Layout */
	.game-layout {
		display: flex;
		gap: 1rem;
		justify-content: center;
	}

	.game-board-area {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		align-items: center;
	}

	.side-panel {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 180px;
		max-width: 260px;
	}

	/* Status Bar */
	.status-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 0.5rem 1rem;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		width: 100%;
	}

	.turn-indicator {
		font-weight: 700;
		font-size: 1.1rem;
		color: var(--gold-bright);
	}

	.turn-indicator.chase-turn { color: var(--text-muted); }

	.thinking-dots { display: inline-flex; align-items: baseline; }

	.dots {
		display: inline-block;
		animation: pulse-dots 1.4s infinite;
	}

	@keyframes pulse-dots {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 1; }
	}

	.move-count { font-size: 0.8rem; color: var(--text-muted); }

	/* Captured Pieces */
	.captured-row {
		min-height: 24px;
		display: flex;
		gap: 2px;
		padding: 0 0.5rem;
	}

	.captured-piece { font-size: 1.1rem; opacity: 0.6; }

	/* Chessboard */
	.chessboard {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		width: min(80vw, 480px);
		aspect-ratio: 1;
		border: 2px solid var(--border-hover);
		border-radius: 4px;
		overflow: hidden;
	}

	.square {
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		cursor: pointer;
		border: none;
		padding: 0;
		transition: background-color 0.1s;
	}

	.square.light { background: var(--bg-tertiary); }
	.square.dark { background: var(--bg-secondary); }
	.square.selected { background: rgba(var(--gold-rgb, 212, 114, 138), 0.5) !important; }
	.square.last-move { background: rgba(var(--gold-rgb, 212, 114, 138), 0.2) !important; }
	.square.in-check { background: rgba(220, 38, 38, 0.45) !important; }
	.square.legal-target { cursor: pointer; }
	.square.legal-target:hover { background: rgba(var(--gold-rgb, 212, 114, 138), 0.35) !important; }

	.piece {
		font-size: 2.2rem;
		line-height: 1;
		pointer-events: none;
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
	}

	.move-dot {
		width: 25%;
		height: 25%;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		pointer-events: none;
	}

	/* Board Coordinates */
	.coord-rank {
		position: absolute;
		top: 2px;
		left: 3px;
		font-size: 0.55rem;
		font-weight: 700;
		pointer-events: none;
	}

	.light .coord-rank { color: var(--bg-secondary); }
	.dark .coord-rank { color: var(--bg-tertiary); }

	.coord-file {
		position: absolute;
		bottom: 1px;
		right: 3px;
		font-size: 0.55rem;
		font-weight: 700;
		pointer-events: none;
	}

	.light .coord-file { color: var(--bg-secondary); }
	.dark .coord-file { color: var(--bg-tertiary); }

	/* Promotion Modal */
	.promo-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
	}

	.promo-modal {
		background: var(--bg-surface);
		border: 2px solid var(--gold);
		border-radius: 12px;
		padding: 1rem 1.5rem;
		text-align: center;
	}

	.promo-modal p {
		color: var(--text-secondary);
		margin: 0 0 0.5rem;
	}

	.promo-options { display: flex; gap: 0.5rem; }

	.promo-btn {
		width: 60px;
		height: 60px;
		border: 2px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		font-size: 2rem;
		cursor: pointer;
		transition: all 0.15s;
	}

	.promo-btn:hover {
		border-color: var(--gold-bright);
		transform: scale(1.1);
	}

	/* Move History Panel */
	.move-history {
		background: var(--bg-secondary);
		border-radius: 10px;
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		max-height: 400px;
	}

	.panel-header {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 1px;
		color: var(--text-muted);
		padding: 0.4rem 0.8rem;
		border-bottom: 1px solid var(--border);
	}

	.moves-list {
		overflow-y: auto;
		padding: 0.3rem 0.5rem;
		flex: 1;
	}

	.move-row {
		display: flex;
		gap: 0.3rem;
		font-size: 0.8rem;
		padding: 0.1rem 0;
		font-family: monospace;
	}

	.move-num { color: var(--text-muted); min-width: 24px; }
	.move-white { color: var(--text-primary); min-width: 55px; }
	.move-black { color: var(--text-secondary); }

	/* End Screen */
	.win-content h2 {
		font-family: var(--font-heading);
		font-size: 2rem;
		margin-bottom: 1rem;
		background: linear-gradient(135deg, var(--gold-bright), var(--gold));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.win-msg {
		color: var(--text-secondary);
		font-size: 1.1rem;
		margin-bottom: 1rem;
	}

	.final-moves {
		color: var(--text-muted);
		font-size: 0.85rem;
		margin-bottom: 2rem;
	}

	.back-link {
		display: inline-block;
		text-decoration: none;
		margin-left: 1rem;
	}

	/* Responsive */
	@media (max-width: 700px) {
		.chess-page { padding: 1rem; }

		.game-layout { flex-direction: column; align-items: center; }

		.side-panel {
			max-width: none;
			width: 100%;
		}

		.move-history { max-height: 180px; }

		.chessboard { width: min(95vw, 480px); }

		.title-area h1 { font-size: 2.5rem; }
	}
</style>
