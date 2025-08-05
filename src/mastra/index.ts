import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { pdfToQuestionsWorkflow } from './workflows/generate-questions-from-pdf-workflow';
import { textQuestionAgent } from './agents/text-question-agent';
import { pdfQuestionAgent } from './agents/pdf-question-agent';
import { pdfSummarizationAgent } from './agents/pdf-summarization-agent';
import { registerApiRoute } from "@mastra/core/server";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { getLocalAgents } from "@ag-ui/mastra";
import { CopilotRuntime, copilotRuntimeNodeHttpEndpoint, ExperimentalEmptyAdapter } from "@copilotkit/runtime";
import path from 'path';
import fs from 'fs/promises';
import express from 'express'; // If not already imported

export const mastra = new Mastra({
  workflows: { pdfToQuestionsWorkflow },
  agents: {
    textQuestionAgent,
    pdfQuestionAgent,
    pdfSummarizationAgent,
  },
  server: {
    cors: {
      origin: "*",
      allowMethods: ["*"],
      allowHeaders: ["*"]
    },
    apiRoutes: [
      registerApiRoute("/copilotkit", {
        method: "ALL",
        handler: async (c) => {
          const runtimeContext = new RuntimeContext();
          runtimeContext.set("user-id", c.req.header("X-User-ID") || "anonymous");
          runtimeContext.set("temperature-scale", "celsius");

          const contentType = c.req.header("Content-Type")?.toLowerCase() || "";
          let body: Record<string, any> = {};
          let messages = [];

          if (contentType.startsWith("multipart/form-data") || contentType.startsWith("application/x-www-form-urlencoded")) {
            const formData = await c.req.formData();

            for (let [key, value] of formData.entries()) {
              if (!(value instanceof File)) {
                body[key] = value;
              }
            }

            const messagesEntry = body.messages || "[]";
            messages = JSON.parse(messagesEntry);

            for (let msg of messages) {
              if (msg.experimental_attachments && msg.experimental_attachments.length > 0) {
                for (let att of msg.experimental_attachments) {
                  if (att.contentType === "application/pdf") {
                    const file = formData.get(att.name);
                    if (file instanceof File) {
                      const uploadForm = new FormData();
                      uploadForm.append("file", file);

                      const response = await fetch("https://your-ui-app.com/api/upload", {
                        method: "POST",
                        body: uploadForm,
                      });

                      if (!response.ok) {
                        throw new Error("Upload failed");
                      }

                      const { url: signedUrl } = await response.json();
                      msg.content = (msg.content || "") + `\nAnalyze this PDF: ${signedUrl}`;
                    }
                  }
                }
                delete msg.experimental_attachments;
              }
            }

            body.messages = JSON.stringify(messages);
          } else {
            body = await c.req.json();
          }

          const originalHeaders = c.req.header();
          const newHeaders = new Headers(originalHeaders);
          newHeaders.set("Content-Type", "application/json");

          const newReq = new Request(c.req.url, {
            method: c.req.method,
            headers: newHeaders,
            body: JSON.stringify(body),
          });

          const mastra = c.get("mastra");
          const agents = getLocalAgents({ mastra, resourceId: "pdfQuestionAgent", runtimeContext });
          const p = new CopilotRuntime({ agents });

          return await copilotRuntimeNodeHttpEndpoint({
            endpoint: "/copilotkit",
            runtime: p,
            serviceAdapter: new ExperimentalEmptyAdapter(),
          }).handle(newReq, {});
        },
      }),
    ],
  },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ':memory:',
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
