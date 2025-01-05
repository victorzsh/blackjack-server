import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

/**
 * Cada jogador tem:
 * - id (socket.id)
 * - name (nome escolhido)
 * - cards (array de strings, ex: ["A-hearts", "10-spades"])
 * - total (pontuação calculada)
 * - isDone (se o jogador finalizou ou estourou)
 */
interface PlayerData {
  id: string;
  name: string;
  cards: string[];
  total: number;
  isDone: boolean;
}

/**
 * O estado da sala inclui:
 * - deck (array de cartas embaralhadas)
 * - players (lista de jogadores)
 * - isGameActive (se o jogo está rodando)
 * - currentTurnIndex (índice do jogador na vez)
 * - winnerName (nome do vencedor da partida, caso o jogo tenha terminado)
 * - gameMode (3 ou 5, representando "Melhor de 3" ou "Melhor de 5")
 * - playerWins (número de vitórias de cada jogador)
 */
interface RoomState {
  deck: string[];
  players: PlayerData[];
  isGameActive: boolean;
  currentTurnIndex: number;
  winnerName?: string;
  gameMode: number; // 3 ou 5
  playerWins: { [playerId: string]: number };
}

/**
 * Armazena os estados das salas na memória:
 * rooms["abc123"] -> { deck, players, etc. }
 */
const rooms: { [roomId: string]: RoomState } = {};

// Função para criar e embaralhar um baralho
function createAndShuffleDeck(): string[] {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const ranks = [
    "A",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
  ];
  const deck: string[] = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(`${rank}-${suit}`);
    }
  }
  // Embaralhar (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const rand = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[rand]] = [deck[rand], deck[i]];
  }
  return deck;
}

/**
 * Calcula o total de pontuação das cartas (Blackjack simplificado).
 * A = 1 ou 11.
 * K, Q, J, 10 = 10
 */
function calculateTotal(cards: string[]): number {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    const [rank] = card.split("-");
    if (rank === "A") {
      total += 11;
      aces++;
    } else if (["K", "Q", "J", "10"].includes(rank)) {
      total += 10;
    } else {
      total += parseInt(rank, 10);
    }
  }

  while (aces > 0 && total > 21) {
    total -= 10;
    aces--;
  }
  return total;
}

/**
 * Monta o estado público que será enviado a todos na sala.
 */
function buildPublicGameState(roomId: string) {
  const room = rooms[roomId];
  if (!room) return null;

  return {
    isGameActive: room.isGameActive,
    winnerName: room.winnerName,
    currentTurn: room.players[room.currentTurnIndex]?.id,
    gameMode: room.gameMode,
    playerWins: room.playerWins,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      revealedCards: p.cards, // As cartas são reveladas a todos
      total: p.total, // Pontuação
      isDone: p.isDone,
    })),
  };
}

/**
 * Monta o estado privado para um jogador específico.
 */
function buildPrivateGameState(roomId: string, playerId: string) {
  const room = rooms[roomId];
  if (!room) return null;
  const self = room.players.find((p) => p.id === playerId);
  if (!self) return null;

  return {
    isGameActive: room.isGameActive,
    winnerName: room.winnerName,
    currentTurn: room.players[room.currentTurnIndex]?.id,
    gameMode: room.gameMode,
    playerWins: room.playerWins,
    self: {
      id: self.id,
      name: self.name,
      revealedCards: self.cards,
      hiddenCards: [], // Sem cartas ocultas neste exemplo
      total: self.total,
      isDone: self.isDone,
    },
    others: room.players
      .filter((p) => p.id !== playerId)
      .map((o) => ({
        id: o.id,
        name: o.name,
        revealedCards: o.cards,
        total: o.total,
        isDone: o.isDone,
      })),
  };
}

// ------------------- SERVIDOR EXPRESS + SOCKET.IO -------------------

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

/**
 * Endpoint que cria uma sala e retorna o roomId.
 * Recebe via body o gameMode (3 ou 5), default 3.
 */
app.post("/create-room", (req, res) => {
  const { gameMode } = req.body;
  const mode = gameMode === 5 ? 5 : 3; // default to 3

  const roomId = Math.random().toString(36).substring(2, 8); // Gera string pseudo-única
  rooms[roomId] = {
    deck: [],
    players: [],
    isGameActive: false,
    currentTurnIndex: 0,
    gameMode: mode,
    playerWins: {},
  };
  console.log("Sala criada:", roomId, "Game Mode:", mode);
  res.json({ roomId });
});

/**
 * Apenas um endpoint GET de teste.
 */
app.get("/", (req, res) => {
  res.send("Servidor Blackjack rodando!");
});

// Lida com conexões Socket.IO
io.on("connection", (socket) => {
  console.log("Cliente conectado:", socket.id);

  /**
   * Jogador entra numa sala
   */
  socket.on("joinRoom", ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      // Se a sala não existe, responde com erro
      socket.emit("roomError", { message: "Sala não encontrada." });
      return;
    }

    // Verifica se o jogador já está na sala
    const alreadyInRoom = room.players.find((p) => p.id === socket.id);
    if (!alreadyInRoom) {
      const newPlayer: PlayerData = {
        id: socket.id,
        name: playerName || "Jogador",
        cards: [], // Inicia sem cartas
        total: 0,
        isDone: false,
      };
      room.players.push(newPlayer);
      room.playerWins[socket.id] = 0; // Inicializa os pontos
    }

    socket.join(roomId);
    console.log(
      `Jogador ${socket.id} (${playerName}) entrou na sala ${roomId}`
    );

    // Emite ao jogador local que ele entrou
    socket.emit("roomJoined", { playerId: socket.id, playerName });

    // Emite estado público para todos na sala
    io.to(roomId).emit("gameUpdatePublic", buildPublicGameState(roomId));

    // Emite estado privado somente a esse jogador
    socket.emit("gameUpdatePrivate", buildPrivateGameState(roomId, socket.id));
  });

  /**
   * Inicia o jogo (embaralha deck e zera estado)
   */
  socket.on("startGame", (roomId: string) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("roomError", { message: "Sala não encontrada." });
      return;
    }

    if (room.isGameActive) {
      socket.emit("roomError", { message: "Jogo já está ativo." });
      return;
    }

    if (room.players.length < 1) {
      socket.emit("roomError", { message: "Necessário pelo menos 1 jogador." });
      return;
    }

    // Prepara/embaralha deck
    room.deck = createAndShuffleDeck();
    room.isGameActive = true;
    room.currentTurnIndex = 0;
    room.winnerName = undefined;

    // Zera estado dos jogadores
    for (const p of room.players) {
      p.cards = [];
      p.total = 0;
      p.isDone = false;
    }

    // NÃO distribui cartas inicialmente

    // Emite estado atualizado
    io.to(roomId).emit("gameUpdatePublic", buildPublicGameState(roomId));
    for (const p of room.players) {
      io.to(p.id).emit(
        "gameUpdatePrivate",
        buildPrivateGameState(roomId, p.id)
      );
    }

    console.log(`Jogo iniciado na sala ${roomId}`);
  });

  /**
   * Evento para iniciar a próxima rodada
   */
  socket.on("startNextRound", (roomId: string) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("roomError", { message: "Sala não encontrada." });
      return;
    }

    if (room.isGameActive) {
      socket.emit("roomError", { message: "Jogo já está ativo." });
      return;
    }

    if (room.winnerName) {
      socket.emit("roomError", { message: "Match já foi concluído." });
      return;
    }

    // Prepara/embaralha deck
    room.deck = createAndShuffleDeck();
    room.isGameActive = true;
    room.currentTurnIndex = 0;
    room.winnerName = undefined;

    // Zera estado dos jogadores para a nova rodada
    for (const p of room.players) {
      p.cards = [];
      p.total = 0;
      p.isDone = false;
    }

    // NÃO distribui cartas inicialmente

    // Emite estado atualizado
    io.to(roomId).emit("gameUpdatePublic", buildPublicGameState(roomId));
    for (const p of room.players) {
      io.to(p.id).emit(
        "gameUpdatePrivate",
        buildPrivateGameState(roomId, p.id)
      );
    }

    console.log(`Próxima rodada iniciada na sala ${roomId}`);
  });

  /**
   * Evento para reiniciar a partida (zerando os placares)
   */
  socket.on("restartMatch", (roomId: string) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("roomError", { message: "Sala não encontrada." });
      return;
    }

    if (room.isGameActive) {
      socket.emit("roomError", {
        message: "Jogo está ativo. Não pode reiniciar agora.",
      });
      return;
    }

    // Reseta placar de vitórias
    for (const playerId in room.playerWins) {
      room.playerWins[playerId] = 0;
    }

    room.winnerName = undefined;

    // Emite estado atualizado
    io.to(roomId).emit("gameUpdatePublic", buildPublicGameState(roomId));
    for (const p of room.players) {
      io.to(p.id).emit(
        "gameUpdatePrivate",
        buildPrivateGameState(roomId, p.id)
      );
    }

    console.log(`Match reiniciado na sala ${roomId}`);
  });

  /**
   * Ações de jogo: "hit" ou "stand"
   */
  socket.on("gameAction", ({ roomId, action }) => {
    const room = rooms[roomId];
    if (!room || !room.isGameActive) return;

    // Encontra o jogador e checa se é a vez dele
    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex < 0) {
      socket.emit("roomError", { message: "Jogador não está na sala." });
      return;
    }
    if (playerIndex !== room.currentTurnIndex) {
      socket.emit("roomError", { message: "Não é a sua vez." });
      return;
    }
    const player = room.players[playerIndex];

    if (action === "hit") {
      // Compra uma carta
      const newCard = room.deck.pop();
      if (newCard) {
        player.cards.push(newCard);
        player.total = calculateTotal(player.cards);
        // Se estourou > 21, marca done
        if (player.total > 21) {
          player.isDone = true;
        }
      }
    } else if (action === "stand") {
      player.isDone = true;
    } else {
      socket.emit("roomError", { message: "Ação inválida." });
      return;
    }

    // Verifica se todos os jogadores terminaram (isDone ou estouraram)
    let allDone = true;
    for (const p of room.players) {
      if (!p.isDone && p.total <= 21) {
        allDone = false;
        break;
      }
    }

    if (allDone) {
      // Determina o vencedor da rodada (maior total <=21)
      let bestScore = -1;
      let roundWinner: PlayerData | null = null;
      for (const p of room.players) {
        if (p.total <= 21 && p.total > bestScore) {
          bestScore = p.total;
          roundWinner = p;
        }
      }

      if (roundWinner) {
        // Incrementa o número de vitórias
        room.playerWins[roundWinner.id] += 1;
        console.log(
          `Rodada vencedora: ${roundWinner.name} com ${roundWinner.total}`
        );
        io.to(roomId).emit("gameUpdatePublic", {
          playerId: roundWinner.id,
          playerName: roundWinner.name,
          playerTotal: roundWinner.total,
        });
      } else {
        // Nenhum vencedor da rodada (todos estouraram)
        console.log(`Rodada sem vencedor na sala ${roomId}`);
      }

      // Verifica se algum jogador atingiu o número necessário de vitórias
      const requiredWins = room.gameMode; // Melhor de 3: 3; Melhor de 5: 5
      let matchWinner: PlayerData | null = null;
      for (const p of room.players) {
        if (room.playerWins[p.id] >= requiredWins) {
          matchWinner = p;
          break;
        }
      }

      if (matchWinner) {
        // Declara o vencedor do match
        room.isGameActive = false;
        room.winnerName = matchWinner.name;
        console.log(`Match vencido por ${matchWinner.name}`);
      } else {
        // Não inicia automaticamente uma nova rodada
        room.isGameActive = false; // Marca que a rodada terminou

        console.log(
          `Rodada terminada na sala ${roomId}. Aguardando iniciar a próxima rodada.`
        );
      }

      // Emite estado atualizado
      io.to(roomId).emit("gameUpdatePublic", buildPublicGameState(roomId));
      for (const p of room.players) {
        io.to(p.id).emit(
          "gameUpdatePrivate",
          buildPrivateGameState(roomId, p.id)
        );
      }

      return;
    } else {
      // Passa a vez ao próximo jogador não finalizado
      do {
        room.currentTurnIndex =
          (room.currentTurnIndex + 1) % room.players.length;
      } while (room.players[room.currentTurnIndex].isDone && room.isGameActive);
    }

    // Emite estado atualizado
    io.to(roomId).emit("gameUpdatePublic", buildPublicGameState(roomId));
    for (const p of room.players) {
      io.to(p.id).emit(
        "gameUpdatePrivate",
        buildPrivateGameState(roomId, p.id)
      );
    }
  });

  /**
   * Desconexão
   */
  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id);

    // Remove o jogador das salas em que está
    for (const [rid, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx >= 0) {
        room.players.splice(idx, 1);
        delete room.playerWins[socket.id];
        console.log(`Jogador ${socket.id} removido da sala ${rid}`);
        // Se a sala ficar vazia, removê-la
        if (room.players.length === 0) {
          delete rooms[rid];
          console.log(`Sala ${rid} removida (vazia)`);
        } else {
          // Atualiza estado para os demais
          io.to(rid).emit("gameUpdatePublic", buildPublicGameState(rid));
        }
      }
    }
  });
});

// Inicia o servidor
const PORT = 4000;
server.listen(PORT, () => {
  console.log(`Servidor Blackjack rodando na porta ${PORT}`);
});
