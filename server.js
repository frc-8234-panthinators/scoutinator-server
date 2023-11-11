import express from 'express';
import ky from 'ky';
import cors from 'cors';
import levelup from 'levelup';
import leveldown from 'leveldown';
import ProgressBar from 'progress';
import readline from 'readline';

const API_KEY = "yxU0mwcQkAOrBoKueQqXEd1hNRo0aKQesITYfKzMQAfIfXT0VcCH6TC59vMd3vXZ"

const bacache = levelup(leveldown('./bluealliance_cache'));

const cachePrebuilding = false;

let bar;

if (cachePrebuilding) {
  bar = new ProgressBar('Building Image Cache :bar :current/:total :percent :etas remaining', { total: 10000 });

  bacache.get('cache_built', async (err, value) => {
    if (err) {
      console.log("Cache not found, cache rebuilding will begin in 5 seconds...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      await buildCache();
    } else {
      console.log("Cache found, starting server...");
      startServer();
    }
  });

} else {
  console.warn("Cache prebuilding is disabled, real-time caching will be used. This may cause slower first load times. Please enable cache prebuilding in server.js during production.");
  console.log("The server will start in 5 seconds...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  startServer();
}

async function buildCache() {
  console.clear();
  for (let i = 1; i <= 10000; i++) {
    let foundImgur = false;
    readline.cursorTo(process.stdout, 0, 0);
    let teamYears;
    bar.tick();
    try {
      teamYears = await ky.get(`https://www.thebluealliance.com/api/v3/team/frc${i}/years_participated`, {headers: {'X-TBA-Auth-Key': API_KEY}}).json();
    } catch (error) {
      if (error.response && error.response.status === 404) {
        readline.cursorTo(process.stdout, 0, 2);
        readline.clearLine(process.stdout, 2);
        process.stdout.write(`frc${i} does not exist!`);
        continue;
      }
    }
    let subBar = new ProgressBar(`Gathering media for frc${i} :bar :percent :etas remaining`, { total: teamYears.length , clear: true});
    readline.cursorTo(process.stdout, 0, 1);
    for (let year of teamYears) {
      await new Promise((resolve, reject) => {
        bacache.get(`frc${i}-${year}`, async (err, value) => {
          if (err) {
            subBar.tick();
            const teamMedia = await ky.get(`https://www.thebluealliance.com/api/v3/team/frc${i}/media/${year}`, {headers: {'X-TBA-Auth-Key': API_KEY}}).json();
            if (teamMedia.length == 0) {
              bacache.put(`frc${i}-${year}`, "no_media");
            } else {
              for (let image of teamMedia) {
                if (image.type == 'imgur') {
                  bacache.put(`frc${i}-${year}`, image.direct_url);
                  foundImgur = true;
                  break;
                }
              }
              if (!foundImgur) {
                bacache.put(`frc${i}-${year}`, "no_media");
              }
            }
          } else {
            subBar.tick();
          }
          resolve();
        });
      });
    }
  }
  readline.cursorTo(process.stdout, 0, 2);
  readline.clearLine(process.stdout, 2);
  process.stdout.write(`Cache built! Please start the server again.`);
  bacache.put('last_updated', Date.now());
  bacache.put('cache_built', true);
}

function startServer() {
  let app = express();
  app.use(
    express.urlencoded({
      extended: true,
    })
  );
  app.use((err, req, res, next) => {
      // Handle the error here
      console.error(err.stack);
      res.status(500).send('Something broke!');
  });

  process.on('uncaughtException', (err) => {
      console.error('Uncaught Exception:', err);
  });

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin || true) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  }));

  app.get('/getTeamYears', async (req, res) => {
    const teamNum = req.query.team;
    try {
      const teamYears = await ky.get(`https://www.thebluealliance.com/api/v3/team/frc${teamNum}/years_participated`, {headers: {'X-TBA-Auth-Key': API_KEY}}).json();
      res.json(teamYears);
    } catch (e) {
      res.json(e.name);
    }
  });

  app.get('/getTeamEvents', async (req, res) => {
    const teamNum = req.query.team;
    const year = req.query.year;
    try {
      const teamEvents = await ky.get(`https://www.thebluealliance.com/api/v3/team/frc${teamNum}/events/${year}`, {headers: {'X-TBA-Auth-Key': API_KEY}}).json();
      res.json(teamEvents);
    } catch (e) {
      res.json(e.name);
    }
  });

function calculateWeightedAverage(pastScores) {
  let totalWeight = 0;
  let weightedScoreSum = 0;

  for (let i = 0; i < pastScores.length; i++) {
      // Define the weight for this score
      let weight = i + 1;

      // Add to the total weight
      totalWeight += weight;

      // Add to the weighted score sum
      weightedScoreSum += weight * pastScores[i];
  }

  return weightedScoreSum / totalWeight;
}

  app.get('/getTeamMatchData', async (req, res) => {
    const teamNum = req.query.team;
    const event = req.query.event;
    try {
      const teamMatches = await ky.get(`https://www.thebluealliance.com/api/v3/team/frc${teamNum}/event/${event}/matches`, {headers: {'X-TBA-Auth-Key': API_KEY}}).json();
      //if teamMatches is empty
      if (teamMatches.length == 0) {
        return res.json({"message": "No data found for this event."});
      }
      let data = {
        graphs: [
          {
            "title": "Est. Team Score",
            "type": "line",
            "labels": [],
            "data": [],
          }
        ]
      };
      let winCount = 0;
      let lossCount = 0;
      let qualNums = [];
      let scoreData = [];
      let oldScoreData = [];
      for (let match of teamMatches) {
        if (match.comp_level == 'qm') {
          let alliance;
          if (match.alliances.blue.team_keys.includes(`frc${teamNum}`)) {
            alliance = 'blue';
          } else {
            alliance = 'red';
          }

          const teamScore = match.score_breakdown[alliance].totalPoints/3;
          const matchNum = match.match_number;
          qualNums.push(matchNum);
          oldScoreData.push(teamScore);

          const estimatedTeamScore = calculateWeightedAverage(oldScoreData);
          scoreData.push(estimatedTeamScore);
          
          const teamAllianceScore = match.score_breakdown[alliance].totalPoints;
          const opponentAllianceScore = match.score_breakdown[alliance == 'blue' ? 'red' : 'blue'].totalPoints;
          if (teamAllianceScore > opponentAllianceScore) {
            winCount++;
          } else {
            lossCount++;
          }
        }
      }
      if (qualNums.length == 0) {
        return res.json({"message": "No data found for this event."});
      }
      // sort qualNums and scoreData by qualNums
      let sortedQualNums = [...qualNums].sort((a, b) => a - b);
      let sortedScoreData = [];
      for (let qualNum of sortedQualNums) {
        sortedScoreData.push(scoreData[qualNums.indexOf(qualNum)]);
      }
      data.graphs[0].labels = sortedQualNums;
      for (let i = 0; i < data.graphs[0].labels.length; i++) {
        data.graphs[0].labels[i] = `Qual ${data.graphs[0].labels[i]}`;
      }
      data.graphs[0].data = sortedScoreData;
      let winLossPie = {
        title: 'Win/Loss',
        type: 'pie',
        data: [
          {
            name: 'Wins',
            population: winCount,
            color: "#58ba6d",
            legendFontColor: '#e3e2e6',
            legendFontSize: 15
          },
          {
            name: 'Losses',
            population: lossCount,
            color: "#9a5c5c",
            legendFontColor: '#e3e2e6',
            legendFontSize: 15
          }
        ]
      }
      data.graphs.push(winLossPie);
      
      res.json(data);
    } catch (e) {
      res.json({error: e.name, message: e.message});
    }
  });

  app.get('/getTeamMedia', async (req, res) => {
    const teamNum = req.query.team;
    const year = req.query.year;
    await new Promise((resolve, reject) => {
      bacache.get(`frc${teamNum}-${year}`, async (err, value) => {
        if (err) {
          console.log(`Cache miss for frc${teamNum}-${year}, fetching from TBA...`)
          try {
            const teamMedia = await ky.get(`https://www.thebluealliance.com/api/v3/team/frc${teamNum}/media/${year}`, {headers: {'X-TBA-Auth-Key': API_KEY}}).json();
            if (teamMedia.length == 0) {
              bacache.put(`frc${teamNum}-${year}`, "no_media");
              return res.json({media: "no_media", message: "build_cache"});
            }
            for (let image of teamMedia) {
              if (image.type == 'imgur') {
                bacache.put(`frc${teamNum}-${year}`, image.direct_url);
                return res.json({media: image.direct_url, message: "build_cache"});
              }
            }
            bacache.put(`frc${teamNum}-${year}`, "no_media");
            return res.json({media: "no_media", message: "build_cache"});
          } catch (e) {
            console.log(e)
          }
        } else {
          console.log(`Cache hit for frc${teamNum}-${year}, returning cached value...`)
          res.json({media: value.toString(), message: "cache_hit"});
        }
        resolve();
      });
    });
  });

  app.listen(8234, () => {
      console.log(`The server has started!`);
  });
}