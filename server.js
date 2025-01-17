"use strict";

// init project
const express = require("express"),
  app = express(),
  session = require("express-session"),
  passport = require("passport"),
  Local = require("passport-local").Strategy,
  bodyParser = require("body-parser"),
  low = require("lowdb"),
  FileSync = require("lowdb/adapters/FileSync"),
  adapter = new FileSync(".data/db.json"),
  bcrypt = require("bcryptjs"),
  shortid = require("shortid"),
  rateLimit = require("express-rate-limit"),
  compression = require("compression"),
  morgan = require("morgan"),
  fs = require("fs"),
  path = require("path"),
  expressSanitizer = require("express-sanitizer");

const MongoClient = require("mongodb").MongoClient;
const uri = `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@cluster0-3oa7e.mongodb.net/admin?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true });

let user_collection = null;
let comment_collection = null;
client.connect(err => {
  user_collection = client.db("a5").collection("users");
  comment_collection = client.db("a5").collection("comments");
});

const salt = bcrypt.genSaltSync(10);

// create a write stream (in append mode)
var accessLogStream = fs.createWriteStream(path.join(__dirname, "access.log"), {
  flags: "a"
});
// setup the logger
app.use(morgan("combined", { stream: accessLogStream }));

app.use((req, res, next) => {
  if (req.headers["x-forwarded-proto"].split(",")[0] !== "https")
    // the statement for performing our redirection
    res.redirect("https://" + req.headers.host + req.url);
  else return next();
});

app.use(compression({ level: 6 }));

app.use(express.static("./public"));
app.use(bodyParser.json());
app.use(expressSanitizer());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
);
app.use(passport.initialize());
app.use(passport.session());

/** Basic middleware to force login states for different pages **/
const isNotLoggedIn = function(req, res, next) {
  if (undefined === req.user) {
    next();
  } else {
    res.redirect("/home");
  }
};

const isLoggedIn = function(req, res, next) {
  if (undefined === req.user) {
    res.redirect("/");
  } else {
    next();
  }
};
/** ----------------------------------------------------------- **/

/** --------- Login, Signup, Change Password routes ----------- **/
// Modified rom lecture notes
// all authentication requests in passwords assume that your client
// is submitting a field named "username" and field named "password".
// these are both passed as arugments to the authentication strategy.
const myLocalStrategy = function(username, password, done) {
  const users = user_collection
    .find({ username: username })
    .toArray((err, res) => {
      // if user is undefined, then there was no match for the submitted username
      if (res === undefined || res.length === 0) {
        /* arguments to done():
       - an error object (usually returned from database requests )
       - authentication status
       - a message / other data to send to client
      */
        return done(null, false, {
          message: "Incorrect username or password!"
        });
      } else if (bcrypt.compareSync(password, res[0].password)) {
        // we found the user and the password matches!
        // go ahead and send the userdata... this will appear as request.user
        // in all express middleware functions.
        return done(null, { username, password });
      } else {
        // we found the user but the password didn't match...
        return done(null, false, { message: "Incorrect username or password" });
      }
    });
};

passport.use(new Local(myLocalStrategy));

// Unique identifiers for users are their usernames, serialize based on that
passport.serializeUser((user, done) => done(null, user.username));
passport.deserializeUser((username, done) => {
  const user = user_collection
    .find({ username: username })
    .toArray((err, res) => {
      if (res !== undefined && res.length > 0) {
        done(null, res[0]);
      } else {
        done(null, false, { message: "user not found; session not restored" });
      }
    });
});

app.post("/login", passport.authenticate("local"), function(req, res) {
  if (undefined === req.user) {
    res.json({ status: req.message });
  } else {
    res.json({ status: 200 });
  }
});

app.post("/signup", isNotLoggedIn, function(req, response) {
  const requested_username = req.body.username;
  const requested_password = req.body.password;

  user_collection
    .find({ username: requested_username })
    .toArray((err, users) => {
      if (undefined === users || users.length === 0) {
        const hash = bcrypt.hashSync(requested_password, salt);
        const new_user = {
          username: requested_username,
          password: hash,
          awards: []
        };

        user_collection.insertOne(new_user);

        response.json({ status: "success" });
      } else {
        response.json({ status: "failed" });
      }
    });
});

app.post("/change_password", isLoggedIn, function(req, response) {
  const old_password = req.body.old_password;
  const new_password = req.body.new_password;

  if (bcrypt.compareSync(old_password, req.user.password)) {
    user_collection.updateOne(
      { username: req.user.username },
      { $set: { password: bcrypt.hashSync(new_password, salt) } },
      (err, result) => {
        response.json({ status: "success" });
      }
    );
  } else {
    response.json({ status: "failed" });
  }
});

/** --------- End Login, Signup, Change Password ------------------------ **/

// Filter all requests on URL length (max 42, very arbitrary) and header length (2048, also arbitrary)
// Long URLs results in a 414, long headers in a 431
app.use(function(req, response, next) {
  if (req.url.length > 42) {
    req.award_code = 414;
    response.status(414).end();
  } else if (JSON.stringify(req.headers).length > 2048) {
    if (undefined !== req.user) addAward(req.user.username, 431);
    response.status(431);
    response.end();
  }
  next();
});

// Filter all POST requests based on body length
// Anything over 1024 characters (arbitrary) results in a 413
app.post("/*", function(req, response, next) {
  if (JSON.stringify(req.body).length > 1024) {
    if (undefined !== req.user) addAward(req.user.username, 413);
    response.status(413);
    response.end();
  } else {
    next();
  }
});

/** -------------- Commenting -------------------------------------------- **/
app.post("/add_comment", isLoggedIn, function(req, res, next) {
  console.log(req.headers);
  if (isDoubleByte(req.body.message)) {
    req.award_code = 422;
    next();
  } else {
    const username = req.user.username;

    const new_comment = {
      id: shortid.generate(),
      message: req.body.message,
      timestamp: new Date().getTime(),
      username: username
    };

    comment_collection.insertOne(new_comment);

    req.award_code = 201;
    next();
  }
});

app.post("/remove_comment", isLoggedIn, function(req, res, next) {
  const username = req.user.username;
  const comment_id = req.body.message_id;

  comment_collection.find({ id: comment_id }).toArray((err, comments) => {
    if (comments === undefined || comments.length === 0) {
      res.status(200);
    } else if (comments[0].username !== username) {
      req.award_code = 403;
    } else {
      comment_collection.deleteOne({ id: comment_id });
      req.award_code = 200;
    }
    next();
  });
});

app.get("/comments", isLoggedIn, function(req, res) {
  comment_collection
    .find({})
    .sort({ timestamp: -1 })
    .toArray((err, comments) => {
      res.json({
        username: req.user.username,
        messages: comments
      });
    });
});

/** -------------------------- End commenting ----------------------------------------- **/

const addAward = function(username, code) {
  user_collection.updateOne(
    { username: username },
    { $addToSet: { awards: code } }
  );
};

// From https://stackoverflow.com/questions/147824/how-to-find-whether-a-particular-string-has-unicode-characters-esp-double-byte
// Use to filter for Unicode - arbitrary requirement to provide a plausible reason for the 422
function isDoubleByte(str) {
  for (var i = 0, n = str.length; i < n; i++) {
    if (str.charCodeAt(i) > 255) {
      return true;
    }
  }
  return false;
}

// app.get("/users", isLoggedIn, function(req, res) {
//   res.json(db.get("users").value());
// });

// http://expressjs.com/en/starter/basic-routing.html
app.get("/", isNotLoggedIn, function(request, response) {
  response.sendFile(__dirname + "/views/index.html");
});

app.get("/sitemap", function(request, response) {
  response.sendFile(__dirname + "/views/sitemap.txt");
});

app.get("/about", function(request, response) {
  response.sendFile(__dirname + "/views/about.html");
});

app.get("/hints", function(request, response) {
  response.sendFile(__dirname + "/views/hints.html");
});

app.get("/help", function(request, response) {
  response.sendFile(__dirname + "/views/help.html");
});

app.get("/changePassword", isLoggedIn, function(request, response) {
  response.sendFile(__dirname + "/views/change_password.html");
});

// /home is rate limited to 5 requests in 5 seconds (arbitrarily low to make it easy to obtain, but not annoyingly so)
// Going over this results in a 429
const rateLimitHandler = function(req, res, next) {
  addAward(req.user.username, 429);
  res.status(429).sendFile(__dirname + "/views/errors/429.html");
};
const limiter = rateLimit({
  windowMs: 5 * 1000,
  max: 5,
  handler: rateLimitHandler
});
app.use("/home", isLoggedIn);
app.use("/home", limiter);
app.get("/home", function(request, response) {
  response.status(200);
  addAward(request.user.username, 200);
  response.sendFile(__dirname + "/views/home.html");
});

app.get("/logout", function(req, res) {
  req.logout();
  res.redirect("/");
});

// Out of f>100 results in an error, can't return a result so 500
app.get("/exponential/:x/:f", isLoggedIn, function(req, res, next) {
  const x = req.params.x;
  const f = req.params.f;

  try {
    res.json({ result: Number.parseFloat(x).toExponential(f) });
    req.award_code = 200;
  } catch (error) {
    req.award_code = 500;
    next();
  }
});

// This server only serves Earl Grey, Hot
app.get("/brewCoffee", function(req, res, next) {
  req.award_code = 418;
  next();
});

// Yeah, we can't let you see this
app.get("/area51", function(req, res, next) {
  req.award_code = 451;
  next();
});

// Just a simple way of getting this user
app.get("/me", isLoggedIn, function(req, res, next) {
  req.award_code = 200;
  res.json(req.user);
});

// Remove a comment via the DELETE method is no-no (even though it really does make sense)
app.delete("/remove_comment", function(req, res, next) {
  req.award_code = 405;
  res.set("Allowed", "POST");
  next();
});

// PUTS just aren't allowed at all, so 501
app.put("/*", function(req, res, next) {
  req.award_code = 501;
  next();
});

// If nothing else set an award or ended the result, you end up here
app.all("/*", function(req, res, next) {
  if (undefined === req.award_code) {
    req.award_code = 404;
  }
  next();
});

// Serve static award/error pages
app.use(function(req, res, next) {
  if (undefined !== req.user) {
    addAward(req.user.username, req.award_code);
  }

  res.status(req.award_code);
  if (404 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/404.html");
  } else if (418 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/418.html");
  } else if (451 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/451.html");
  } else if (500 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/500.html");
  } else if (414 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/414.html");
  } else if (429 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/429.html");
  } else if (405 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/405.html");
  } else if (403 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/403.html");
  } else if (501 === req.award_code) {
    res.sendFile(__dirname + "/views/errors/501.html");
  } else {
    res.end();
  }
});

// listen for requests :)
const listener = app.listen(process.env.PORT, function() {
  console.log("Your app is listening on port " + listener.address().port);
});
