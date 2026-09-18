const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});

const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const Busboy = require('busboy');

const PORT = Number(process.env.PORT || 3000);
const CLIENT_URL = process.env.CLIENT_URL || 'https://photocall-frontend.vercel.app';
const PUBLIC_API_URL = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
const JWT_SECRET = String(process.env.JWT_SECRET || '').trim();

function requireJwtSecret() {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured on the backend. Add it to the Vercel Production environment variables.');
  }
  return JWT_SECRET;
}

const app = express();
const server = http.createServer(app);

const configuredOrigins = String(process.env.CORS_ORIGIN || CLIENT_URL)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set(configuredOrigins)];

function corsOrigin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }

  return callback(new Error('CORS origin not allowed'));
}

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));

app.use(express.json({
  limit: '2mb'
}));

app.use(express.urlencoded({
  extended: false
}));

/*
|--------------------------------------------------------------------------
| DATABASE
|--------------------------------------------------------------------------
*/

let dbPromise = null;

async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  if (!dbPromise) {
    dbPromise = mongoose.connect(
      process.env.MONGODB_URI,
      {
        serverSelectionTimeoutMS: 10000
      }
    );
  }

  await dbPromise;
}

/*
|--------------------------------------------------------------------------
| DATABASE MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(async (req, _res, next) => {
  // These endpoints are intentionally database-independent so a fresh Vercel
  // deployment can report configuration/runtime problems instead of failing
  // during function initialization. All authenticated/data routes still use DB.
  if (req.path === '/health' || req.path === '/api/config') {
    return next();
  }

  try {
    await connectDb();
    next();
  } catch (error) {
    next(error);
  }
});

/*
|--------------------------------------------------------------------------
| USER MODEL
|--------------------------------------------------------------------------
*/

const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80
      },

      email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
      },

      passwordHash: {
        type: String,
        required: true
      },

      avatarName: {
        type: String,
        default: ''
      },

      avatarEnabled: {
        type: Boolean,
        default: true
      },

      voiceEnabled: {
        type: Boolean,
        default: false
      },

      voiceId: {
        type: String,
        default: ''
      },

      voiceStatus: {
        type: String,
        enum: [
          'none',
          'processing',
          'ready',
          'failed'
        ],
        default: 'none'
      },

      createdAt: {
        type: Date,
        default: Date.now
      }
    },
    {
      versionKey: false
    }
  )
);

/*
|--------------------------------------------------------------------------
| CALL MODEL
|--------------------------------------------------------------------------
*/

const Call = mongoose.model(
  'Call',
  new mongoose.Schema(
    {
      room: {
        type: String,
        required: true,
        index: true
      },

      callerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },

      calleeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },

      startedAt: {
        type: Date,
        default: Date.now
      },

      endedAt: Date,

      status: {
        type: String,
        enum: [
          'started',
          'ended'
        ],
        default: 'started'
      }
    },
    {
      versionKey: false
    }
  )
);

/*
|--------------------------------------------------------------------------
| AUTH HELPERS
|--------------------------------------------------------------------------
*/

function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    avatarName: user.avatarName || '',
    avatarEnabled: !!user.avatarEnabled,
    voiceEnabled: !!user.voiceEnabled,
    voiceReady: user.voiceStatus === 'ready'
  };
}

function sign(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      name: user.name
    },
    requireJwtSecret(),
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';

  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      message: 'Authentication required.'
    });
  }

  try {
    req.user = jwt.verify(
      token,
      requireJwtSecret()
    );

    next();
  } catch {
    return res.status(401).json({
      message: 'Invalid or expired token.'
    });
  }
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
  '/health',
  (_req, res) => {
    const missing = [];
    if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');
    if (!JWT_SECRET) missing.push('JWT_SECRET');

    const configured = {
      mongodb: Boolean(process.env.MONGODB_URI),
      jwt: Boolean(JWT_SECRET),
      metered: Boolean(process.env.METERED_DOMAIN && process.env.METERED_TURN_API_KEY),
      elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY)
    };

    const healthy = missing.length === 0;

    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      service: 'photocall',
      database: mongoose.connection.readyState === 1 ? 'connected' : 'not-connected',
      configured,
      missing,
      time: new Date().toISOString()
    });
  }
);

/*
|--------------------------------------------------------------------------
| METERED TURN / ICE SERVERS
|--------------------------------------------------------------------------
*/

let cachedIceServers = null;
let cachedIceServersAt = 0;

const TURN_CACHE_MS = 5 * 60 * 1000;

async function getMeteredIceServers() {
  const domain = String(
    process.env.METERED_DOMAIN || ''
  ).replace(/\/$/, '');

  const apiKey = String(
    process.env.METERED_TURN_API_KEY || ''
  ).trim();

  if (!domain || !apiKey) {
    return null;
  }

  if (
    cachedIceServers &&
    Date.now() - cachedIceServersAt < TURN_CACHE_MS
  ) {
    return cachedIceServers;
  }

  const url =
    `${domain}/api/v1/turn/credentials?apiKey=` +
    encodeURIComponent(apiKey);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Metered TURN request failed (${response.status})`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data) || !data.length) {
    throw new Error(
      'Metered returned an empty ICE server array'
    );
  }

  cachedIceServers = data;
  cachedIceServersAt = Date.now();

  return data;
}

/*
|--------------------------------------------------------------------------
| WEBRTC CONFIGURATION
|--------------------------------------------------------------------------
*/

app.get(
  '/api/config',
  async (_req, res) => {
    const fallback = [
      {
        urls: [
          'stun:stun.l.google.com:19302'
        ]
      }
    ];

    try {
      const metered =
        await getMeteredIceServers();

      if (metered) {
        return res.json({
          appName: 'PhotoCall',
          apiBaseUrl: PUBLIC_API_URL || CLIENT_URL,
          iceServers: metered,
          turnProvider: 'metered',
          maxPeersPerRoom: 2
        });
      }
    } catch (error) {
      console.error(
        'Metered TURN configuration error:',
        error.message
      );
    }

    const iceServers = [
      ...fallback
    ];

    if (
      process.env.TURN_URL &&
      process.env.TURN_USERNAME &&
      process.env.TURN_CREDENTIAL
    ) {
      iceServers.push({
        urls: process.env.TURN_URL
          .split(',')
          .map(value => value.trim()),

        username:
          process.env.TURN_USERNAME,

        credential:
          process.env.TURN_CREDENTIAL
      });
    }

    res.json({
      appName: 'PhotoCall',
      apiBaseUrl: PUBLIC_API_URL || CLIENT_URL,
      iceServers,
      turnProvider: 'fallback',
      maxPeersPerRoom: 2
    });
  }
);

/*
|--------------------------------------------------------------------------
| REGISTER
|--------------------------------------------------------------------------
*/

app.post(
  '/api/auth/register',
  async (req, res) => {
    try {
      const name =
        String(req.body.name || '').trim();

      const email =
        String(req.body.email || '')
          .trim()
          .toLowerCase();

      const password =
        String(req.body.password || '');

      if (
        name.length < 2 ||
        !email.includes('@') ||
        password.length < 8
      ) {
        return res.status(400).json({
          message:
            'Name, valid email and password of at least 8 characters are required.'
        });
      }

      if (await User.exists({ email })) {
        return res.status(409).json({
          message:
            'An account with that email already exists.'
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const user =
        await User.create({
          name,
          email,
          passwordHash
        });

      res.status(201).json({
        token: sign(user),
        user: publicUser(user)
      });
    } catch (error) {
      console.error(
        'Registration error:',
        error
      );

      res.status(500).json({
        message:
          'Unable to create account.'
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

app.post(
  '/api/auth/login',
  async (req, res) => {
    try {
      const email =
        String(req.body.email || '')
          .trim()
          .toLowerCase();

      const password =
        String(req.body.password || '');

      const user =
        await User.findOne({
          email
        });

      if (
        !user ||
        !(await bcrypt.compare(
          password,
          user.passwordHash
        ))
      ) {
        return res.status(401).json({
          message:
            'Invalid email or password.'
        });
      }

      res.json({
        token: sign(user),
        user: publicUser(user)
      });
    } catch {
      res.status(500).json({
        message:
          'Unable to sign in.'
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| CURRENT USER
|--------------------------------------------------------------------------
*/

app.get(
  '/api/auth/me',
  auth,
  async (req, res) => {
    const user =
      await User.findById(
        req.user.sub
      );

    if (!user) {
      return res.status(404).json({
        message: 'User not found.'
      });
    }

    res.json({
      user: publicUser(user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| USER PREFERENCES
|--------------------------------------------------------------------------
*/

app.patch(
  '/api/profile/preferences',
  auth,
  async (req, res) => {
    const updates = {};

    if (
      typeof req.body.avatarEnabled ===
      'boolean'
    ) {
      updates.avatarEnabled =
        req.body.avatarEnabled;
    }

    if (
      typeof req.body.voiceEnabled ===
      'boolean'
    ) {
      updates.voiceEnabled =
        req.body.voiceEnabled;
    }

    const user =
      await User.findByIdAndUpdate(
        req.user.sub,
        updates,
        {
          new: true
        }
      );

    if (!user) {
      return res.status(404).json({
        message: 'User not found.'
      });
    }

    res.json({
      user: publicUser(user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| AUDIO UPLOAD PARSER
|--------------------------------------------------------------------------
*/

function parseSingleAudio(req) {
  return new Promise(
    (resolve, reject) => {
      const bb = Busboy({
        headers: req.headers,

        limits: {
          files: 1,
          fileSize:
            12 * 1024 * 1024
        }
      });

      let fileBuffer =
        Buffer.alloc(0);

      let filename =
        'voice.webm';

      let mimeType =
        'audio/webm';

      let tooLarge = false;

      bb.on(
        'file',
        (_field, file, info) => {
          filename =
            info.filename ||
            filename;

          mimeType =
            info.mimeType ||
            mimeType;

          file.on(
            'data',
            chunk => {
              fileBuffer =
                Buffer.concat([
                  fileBuffer,
                  chunk
                ]);
            }
          );

          file.on(
            'limit',
            () => {
              tooLarge = true;
            }
          );
        }
      );

      bb.on(
        'error',
        reject
      );

      bb.on(
        'finish',
        () => {
          if (tooLarge) {
            return reject(
              new Error(
                'Voice sample is too large (12MB maximum).'
              )
            );
          }

          resolve({
            buffer: fileBuffer,
            filename,
            mimeType
          });
        }
      );

      req.pipe(bb);
    }
  );
}

/*
|--------------------------------------------------------------------------
| ELEVENLABS VOICE CLONING
|--------------------------------------------------------------------------
*/

app.post(
  '/api/voice/clone',
  auth,
  async (req, res) => {
    if (
      !process.env.ELEVENLABS_API_KEY
    ) {
      return res.status(503).json({
        message:
          'Uploaded voice cloning is not configured. Add ELEVENLABS_API_KEY to the server environment.'
      });
    }

    let sample;

    try {
      sample =
        await parseSingleAudio(req);
    } catch (error) {
      return res.status(400).json({
        message: error.message
      });
    }

    if (!sample.buffer.length) {
      return res.status(400).json({
        message:
          'Upload a voice recording.'
      });
    }

    if (
      !/^audio\//.test(
        sample.mimeType
      )
    ) {
      return res.status(400).json({
        message:
          'The uploaded file must be an audio recording.'
      });
    }

    const user =
      await User.findById(
        req.user.sub
      );

    if (!user) {
      return res.status(404).json({
        message: 'User not found.'
      });
    }

    user.voiceStatus =
      'processing';

    await user.save();

    try {
      const form =
        new FormData();

      form.append(
        'name',
        `PhotoCall-${user._id}`
      );

      form.append(
        'description',
        'User-authorized PhotoCall voice profile'
      );

      form.append(
        'remove_background_noise',
        'true'
      );

      form.append(
        'files[]',
        new Blob(
          [
            sample.buffer
          ],
          {
            type:
              sample.mimeType
          }
        ),
        sample.filename
      );

      const response =
        await fetch(
          'https://api.elevenlabs.io/v1/voices/add',
          {
            method: 'POST',

            headers: {
              'xi-api-key':
                process.env
                  .ELEVENLABS_API_KEY
            },

            body: form
          }
        );

      const data =
        await response
          .json()
          .catch(
            () => ({})
          );

      if (
        !response.ok ||
        !data.voice_id
      ) {
        throw new Error(
          data.detail?.message ||
          data.message ||
          `Voice provider returned ${response.status}`
        );
      }

      user.voiceId =
        data.voice_id;

      user.voiceStatus =
        data.requires_verification
          ? 'processing'
          : 'ready';

      await user.save();

      res.json({
        ok: true,
        voiceId:
          user.voiceId,
        ready:
          user.voiceStatus ===
          'ready',
        requiresVerification:
          !!data.requires_verification
      });
    } catch (error) {
      user.voiceStatus =
        'failed';

      await user.save();

      res.status(502).json({
        message:
          `Voice cloning failed: ${error.message}`
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| ELEVENLABS SPEECH-TO-SPEECH
|--------------------------------------------------------------------------
*/

app.post(
  '/api/voice/convert',
  auth,
  async (req, res) => {
    if (
      !process.env.ELEVENLABS_API_KEY
    ) {
      return res.status(503).json({
        message:
          'Uploaded voice conversion is not configured.'
      });
    }

    const user =
      await User.findById(
        req.user.sub
      );

    if (
      !user?.voiceEnabled ||
      user.voiceStatus !==
        'ready' ||
      !user.voiceId
    ) {
      return res.status(409).json({
        message:
          'Uploaded voice is not enabled or ready.'
      });
    }

    let sample;

    try {
      sample =
        await parseSingleAudio(req);
    } catch (error) {
      return res.status(400).json({
        message: error.message
      });
    }

    const form =
      new FormData();

    form.append(
      'audio',
      new Blob(
        [
          sample.buffer
        ],
        {
          type:
            sample.mimeType
        }
      ),
      sample.filename
    );

    form.append(
      'model_id',
      process.env
        .ELEVENLABS_STS_MODEL ||
        'eleven_multilingual_sts_v2'
    );

    form.append(
      'output_format',
      'mp3_44100_128'
    );

    try {
      const response =
        await fetch(
          `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(
            user.voiceId
          )}?output_format=mp3_44100_128`,
          {
            method: 'POST',

            headers: {
              'xi-api-key':
                process.env
                  .ELEVENLABS_API_KEY
            },

            body: form
          }
        );

      if (!response.ok) {
        const text =
          await response.text();

        throw new Error(
          text.slice(0, 500)
        );
      }

      const audio =
        Buffer.from(
          await response.arrayBuffer()
        );

      res.setHeader(
        'Content-Type',
        'audio/mpeg'
      );

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      res.send(audio);
    } catch (error) {
      res.status(502).json({
        message:
          `Voice conversion failed: ${error.message}`
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| PROFILE
|--------------------------------------------------------------------------
*/

app.patch(
  '/api/profile',
  auth,
  async (req, res) => {
    const avatarName =
      String(
        req.body.avatarName || ''
      )
        .trim()
        .slice(0, 120);

    const user =
      await User.findByIdAndUpdate(
        req.user.sub,
        {
          avatarName
        },
        {
          new: true
        }
      );

    res.json({
      user: publicUser(user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| CREATE CALL
|--------------------------------------------------------------------------
*/

app.post(
  '/api/calls',
  auth,
  async (req, res) => {
    const room =
      String(
        req.body.room || ''
      )
        .trim()
        .slice(0, 80);

    if (!room) {
      return res.status(400).json({
        message:
          'Room code is required.'
      });
    }

    const call =
      await Call.create({
        room,
        callerId:
          req.user.sub
      });

    res.status(201).json({
      id: call._id,
      room,
      status:
        call.status
    });
  }
);

/*
|--------------------------------------------------------------------------
| END CALL
|--------------------------------------------------------------------------
*/

app.patch(
  '/api/calls/:id/end',
  auth,
  async (req, res) => {
    const call =
      await Call.findOneAndUpdate(
        {
          _id:
            req.params.id,

          $or: [
            {
              callerId:
                req.user.sub
            },
            {
              calleeId:
                req.user.sub
            }
          ]
        },

        {
          endedAt:
            new Date(),

          status:
            'ended'
        },

        {
          new: true
        }
      );

    if (!call) {
      return res.status(404).json({
        message:
          'Call not found.'
      });
    }

    res.json({
      ok: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| WEBRTC ROOMS
|--------------------------------------------------------------------------
*/

const rooms =
  new Map();

function roomMembers(room) {
  return (
    rooms.get(room) ||
    new Set()
  );
}

function cleanRoomName(raw) {
  return String(raw || '')
    .trim()
    .replace(
      /[^a-zA-Z0-9_-]/g,
      ''
    )
    .slice(0, 80);
}

/*
|--------------------------------------------------------------------------
| SOCKET AUTHENTICATION
|--------------------------------------------------------------------------
*/

io.use(
  (socket, next) => {
    const token =
      socket.handshake
        .auth?.token;

    if (!JWT_SECRET) {
      return next(new Error('Server JWT configuration is missing.'));
    }

    if (!token) {
      return next(
        new Error(
          'Authentication required'
        )
      );
    }

    try {
      socket.user =
        jwt.verify(
          token,
          requireJwtSecret()
        );

      next();
    } catch {
      next(
        new Error(
          'Invalid or expired token'
        )
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| SOCKET CONNECTION
|--------------------------------------------------------------------------
*/

io.on(
  'connection',
  socket => {
    socket.on(
      'join-room',
      async rawRoom => {
        const room =
          cleanRoomName(
            rawRoom
          );

        if (!room) {
          return socket.emit(
            'server-error',
            {
              message:
                'Room code is required.'
            }
          );
        }

        const members =
          roomMembers(room);

        if (
          members.size >= 2 &&
          !members.has(
            socket.id
          )
        ) {
          return socket.emit(
            'room-full'
          );
        }

        socket.data.room =
          room;

        members.add(
          socket.id
        );

        rooms.set(
          room,
          members
        );

        socket.join(room);

        socket.emit(
          'room-joined',
          {
            room,
            peerCount:
              members.size
          }
        );

        if (
          members.size === 2
        ) {
          socket
            .to(room)
            .emit(
              'peer-ready'
            );

          const call =
            await Call.findOne(
              {
                room,
                status:
                  'started',

                callerId: {
                  $ne: null
                }
              }
            ).sort({
              startedAt:
                -1
            });

          if (
            call &&
            !call.calleeId
          ) {
            call.calleeId =
              socket.user.sub;

            await call.save();
          }
        }
      }
    );

    /*
    |--------------------------------------------------------------------------
    | WEBRTC SIGNALING
    |--------------------------------------------------------------------------
    */

    for (
      const event of [
        'offer',
        'answer',
        'ice-candidate'
      ]
    ) {
      socket.on(
        event,
        payload => {
          const room =
            cleanRoomName(
              payload?.room ||
              socket.data.room
            );

          if (
            !room ||
            socket.data.room !==
              room
          ) {
            return;
          }

          socket
            .to(room)
            .emit(
              event,
              {
                ...payload,
                from:
                  socket.id
              }
            );
        }
      );
    }

    /*
    |--------------------------------------------------------------------------
    | CALL ENDED
    |--------------------------------------------------------------------------
    */

    socket.on(
      'call-ended',
      rawRoom => {
        const room =
          cleanRoomName(
            rawRoom ||
            socket.data.room
          );

        if (room) {
          socket
            .to(room)
            .emit(
              'call-ended'
            );
        }
      }
    );

    /*
    |--------------------------------------------------------------------------
    | LEAVE ROOM
    |--------------------------------------------------------------------------
    */

    socket.on(
      'leave-room',
      () => leave(socket)
    );

    socket.on(
      'disconnect',
      () => leave(socket)
    );
  }
);

/*
|--------------------------------------------------------------------------
| LEAVE ROOM FUNCTION
|--------------------------------------------------------------------------
*/

async function leave(socket) {
  const room =
    socket.data.room;

  if (!room) {
    return;
  }

  const members =
    rooms.get(room);

  if (!members) {
    return;
  }

  members.delete(
    socket.id
  );

  socket
    .to(room)
    .emit(
      'peer-left'
    );

  if (!members.size) {
    rooms.delete(room);
  } else {
    rooms.set(
      room,
      members
    );
  }

  await Call.updateMany(
    {
      room,
      status:
        'started'
    },
    {
      status:
        'ended',

      endedAt:
        new Date()
    }
  ).catch(
    () => {}
  );

  socket.data.room =
    null;
}

/*
|--------------------------------------------------------------------------
| FRONTEND STATIC FILES
|--------------------------------------------------------------------------
*/

app.use(
  express.static(
    path.join(
      __dirname,
      '../frontend'
    )
  )
);

app.get(
  '*',
  (req, res, next) => {
    if (
      req.path.startsWith(
        '/api/'
      ) ||
      req.path ===
        '/health' ||
      req.path.startsWith(
        '/socket.io/'
      )
    ) {
      return next();
    }

    res.sendFile(
      path.join(
        __dirname,
        '../frontend/index.html'
      )
    );
  }
);

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      'Server error:',
      error
    );

    if (
      res.headersSent
    ) {
      return;
    }

    res.status(
      error.status || 500
    ).json({
      message:
        error.message ||
        'Internal server error.'
    });
  }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

if (
  require.main ===
  module
) {
  connectDb()
    .then(() => {
      server.listen(
        PORT,
        () => {
          console.log(
            `PhotoCall backend listening on port ${PORT}`
          );
        }
      );
    })
    .catch(
      error => {
        console.error(
          'Startup failed:',
          error.message
        );

        process.exit(1);
      }
    );
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
  app,
  server,
  io,
  connectDb
};