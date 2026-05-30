import express from 'express';
import multer from 'multer';
import Airtable from 'airtable';
import 'dotenv/config';
import { getDocumentProxy, extractText } from 'unpdf';
import { GoogleGenAI } from '@google/genai';

const app = express();


// Serve the web UI automatically out of the public directory
app.use(express.static('public'));app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Initialize API Management Clients
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// 20-Question Pedagogy Blueprint Schema
const quizSchema = {
  type: "object",
  properties: {
    quizTitle: { type: "string" },
    multipleChoice: {
      type: "array",
      description: "Exactly 10 multiple choice questions evaluating core concepts.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctAnswer: { type: "string" },
          difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] }
        },
        required: ["question", "options", "correctAnswer", "difficulty"]
      }
    },
    fillInTheBlanks: {
      type: "array",
      description: "Exactly 5 fill-in-the-blank questions. Use [___] for the blank space.",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string" },
          correctAnswer: { type: "string" },
          difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] }
        },
        required: ["sentence", "correctAnswer", "difficulty"]
      }
    },
    shortAnswer: {
      type: "array",
      description: "Exactly 5 open-ended analytical questions.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          gradingGuide: { type: "string" },
          difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] }
        },
        required: ["question", "gradingGuide", "difficulty"]
      }
    }
  },
  required: ["quizTitle", "multipleChoice", "fillInTheBlanks", "shortAnswer"]
};

/**
 * Intelligent Wrapper to execute AI operations with Exponential Backoff
 * Absorbs 503 (Server Busy) and 429 (Rate Limit) transient errors seamlessly.
 */
async function callGeminiWithRetry(apiPayload, maxRetries = 3, initialDelay = 2000) {
  let delay = initialDelay;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(apiPayload);
    } catch (error) {
      const isTransientError = error.status === 503 || error.status === 429 || error.message?.includes('high demand');
      
      if (isTransientError && attempt < maxRetries) {
        console.warn(`⚠️ [Attempt ${attempt}/${maxRetries}] Gemini Engine busy (503/429). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Double the wait time for the next attempt
      } else {
        // If it's a permanent error (like an invalid key) or we ran out of retries, throw it
        throw error;
      }
    }
  }
}

// Primary API Endpoint
app.post('/upload-lesson', upload.single('lessonFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a valid PDF lesson.' });
    }

    console.log('Parsing PDF content...');
    const pdf = await getDocumentProxy(new Uint8Array(req.file.buffer));
    const { text: lessonText } = await extractText(pdf);

    console.log('Routing prompt matrix to Gemini processing layer...');
    
    const aiResponse = await callGeminiWithRetry({
      model: 'gemini-2.5-flash',
      contents: `Extract the quiz schema from this document content:\n\n${lessonText}`,
      config: {
        systemInstruction: "You are an advanced pedagogical data architect. Analyze the lesson text provided and extract a comprehensive, high-quality 20-question assessment containing exactly 10 multiple-choice questions, 5 fill-in-the-blank questions, and 5 typed short-answer questions. Carefully distribute difficulties across Easy, Medium, and Hard tiers.",
        responseMimeType: "application/json",
        responseSchema: quizSchema,
      }
    });

    const structuredQuiz = JSON.parse(aiResponse.text);

    console.log('Syncing generated quiz payload to Airtable Master Library...');
    const airtableRecord = await base('Quiz Library').create([
      {
        fields: {
          "Lesson Title": structuredQuiz.quizTitle,
          "Multiple Choice JSON": JSON.stringify(structuredQuiz.multipleChoice),
          "Fill In The Blanks JSON": JSON.stringify(structuredQuiz.fillInTheBlanks),
          "Short Answer JSON": JSON.stringify(structuredQuiz.shortAnswer),
          "Date Generated": new Date().toISOString().split('T')[0]
        }
      }
    ]);

    res.status(200).json({
      message: 'Quiz successfully generated and backed up!',
      airtableId: airtableRecord[0].id,
      quiz: structuredQuiz
    });

  } catch (error) {
    console.error('❌ Operation execution failed completely:', error);
    
    // Send a descriptive error back to your beautiful UI instead of crashing silently
    const clientErrorMessage = error.status === 503 
      ? 'Google free tier servers are currently overloaded. Please wait a moment and try clicking generate again.' 
      : 'An unexpected internal error occurred while compiling your quiz layout.';
      
    res.status(error.status || 500).json({ error: clientErrorMessage });
  }
});

const PORT = process.env.PORT || 3000;
// New Endpoint: AI Short Answer Evaluation Engine
app.post('/grade-short-answers', async (req, res) => {
  try {
    const { questions, studentAnswers } = req.body;

    if (!questions || !studentAnswers) {
      return res.status(400).json({ error: 'Missing evaluation evaluation data payload.' });
    }

    console.log('Routing student answers to Gemini AI Grading Matrix...');
const evaluationPayload = questions.map((q, index) => {
      return {
        questionIndex: index,
        questionText: q.question,
        gradingGuide: q.gradingGuide,
        studentResponse: studentAnswers[index] || "" // Falls back safely if missing
      };
    });
    // Define strict structural grading schema
   const gradingSchema = {
      type: "object",
      properties: {
        totalShortAnswerScore: { type: "number", description: "Sum of all awarded points from all items." },
        evaluations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              questionIndex: { type: "number" },
              scoreAwarded: { type: "number", description: "Score out of 5 points based strictly on matching concepts to the guide." },
              rationale: { type: "string", description: "A single customized sentence explaining what they got right or missed based on their response." }
            },
            required: ["questionIndex", "scoreAwarded", "rationale"]
          }
        }
      },
      required: ["totalShortAnswerScore", "evaluations"]
    };
    const aiResponse = await callGeminiWithRetry({
      model: 'gemini-2.5-flash',
      contents: `Evaluate the student responses provided in this structural matrix against their specific grading keys:\n\n${JSON.stringify(evaluationPayload)}`,
      config: {
        systemInstruction: "You are an objective academic evaluator. Score each item individually on a scale from 0 to 5. Read the 'studentResponse' carefully and match it conceptually to the 'gradingGuide'. Provide unique, customized feedback for each answer based on what the student wrote.",
        responseMimeType: "application/json",
        responseSchema: gradingSchema,
      }
    });

    const gradeBreakdown = JSON.parse(aiResponse.text);
    res.status(200).json(gradeBreakdown);

  } catch (error) {
    console.error('❌ Grading workflow encountered an error:', error);
    res.status(500).json({ error: 'Failed to process subjective grading calculations.' });
  }
});
// New Endpoint: Fetch Historical Quiz Records from Airtable
// Updated Endpoint: Correctly mapped key allocation matrix
// Updated Endpoint: Fetch Historical Quiz Records (Newest First)
app.get('/quiz-history', async (req, res) => {
  try {
    console.log('Querying Airtable Master Library for historical records...');
    
    // Query Airtable and explicitly sort by 'Date Generated' in descending order
    const records = await base('Quiz Library').select({
      sort: [{ field: 'Date Generated', direction: 'desc' }]
    }).all();
// New Endpoint: Delete a Quiz Record from Airtable
app.delete('/quiz-history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Request received to delete record: ${id}`);
    
    // Call Airtable's destroy method
    await base('Quiz Library').destroy(id);
    
    res.status(200).json({ success: true, message: 'Record deleted successfully.' });
  } catch (error) {
    console.error('❌ Failed to delete record from Airtable:', error);
    res.status(500).json({ error: 'Unable to remove quiz record.' });
  }
});
    // Map rows into clean JSON objects for the frontend
    const historyLog = records.map(record => ({
      airtableId: record.id,
      quizTitle: record.get('Lesson Title') || "Untitled Assessment",
      dateGenerated: record.get('Date Generated') || "Recent",
      
      // Parse the JSON blocks safely
      multipleChoice: record.get('Multiple Choice JSON') ? JSON.parse(record.get('Multiple Choice JSON')) : [],
      fillInTheBlanks: record.get('Fill In The Blanks JSON') ? JSON.parse(record.get('Fill In The Blanks JSON')) : [],
      shortAnswer: record.get('Short Answer JSON') ? JSON.parse(record.get('Short Answer JSON')) : []
    }));

    res.status(200).json(historyLog);
  } catch (error) {
    console.error('❌ Failed to pull records from Airtable:', error);
    res.status(500).json({ error: 'Unable to sync historical quiz logs.' });
  }
});
app.listen(PORT, () => console.log(`AI Quiz Operations Engine (Free Tier) running on port ${PORT}`));