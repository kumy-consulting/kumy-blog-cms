import type { Core } from "@strapi/strapi";
import fs from "fs-extra";
import path from "path";
import mime from "mime-types";

// Import seed data
import seedData from "../data/data.json";

const { tags, authors, blogPosts } = seedData;

/**
 * Main bootstrap function called by Strapi on startup
 */
export default async function bootstrap({ strapi }: { strapi: Core.Strapi }) {
  await seedExampleApp(strapi);
}

/**
 * Seeds the application with initial data on first run
 */
async function seedExampleApp(strapi: Core.Strapi) {
  const shouldImportSeedData = await isFirstRun(strapi);

  if (shouldImportSeedData) {
    try {
      console.log("Setting up the template...");
      await importSeedData(strapi);
      console.log("Ready to go");
    } catch (error) {
      console.log("Could not import seed data");
      console.error(error);
    }
  } else {
    console.log("Seed data has already been imported. We cannot reimport unless you clear your database first.");
  }
}

/**
 * Check if this is the first run by looking at the plugin store
 */
async function isFirstRun(strapi: Core.Strapi): Promise<boolean> {
  const pluginStore = strapi.store({
    environment: strapi.config.environment,
    type: "type",
    name: "setup",
  });
  const initHasRun = await pluginStore.get({ key: "initHasRun" });
  await pluginStore.set({ key: "initHasRun", value: true });
  return !initHasRun;
}

/**
 * Set public permissions for content types
 */
async function setPublicPermissions(strapi: Core.Strapi, newPermissions: Record<string, string[]>) {
  // Find the ID of the public role
  const publicRole = await strapi.query("plugin::users-permissions.role").findOne({
    where: { type: "public" },
  });

  if (!publicRole) {
    console.log("Public role not found, skipping permissions setup");
    return;
  }

  // Create the new permissions and link them to the public role
  const allPermissionsToCreate: Promise<unknown>[] = [];
  Object.keys(newPermissions).forEach((controller) => {
    const actions = newPermissions[controller];
    const permissionsToCreate = actions.map((action) => {
      return strapi.query("plugin::users-permissions.permission").create({
        data: {
          action: `api::${controller}.${controller}.${action}`,
          role: publicRole.id,
        },
      });
    });
    allPermissionsToCreate.push(...permissionsToCreate);
  });
  await Promise.all(allPermissionsToCreate);
}

/**
 * Get file size in bytes
 */
function getFileSizeInBytes(filePath: string): number {
  const stats = fs.statSync(filePath);
  return stats.size;
}

/**
 * Get file metadata for upload
 */
function getFileData(fileName: string) {
  const filePath = path.join("data", "uploads", fileName);

  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return null;
  }

  const size = getFileSizeInBytes(filePath);
  const ext = fileName.split(".").pop() || "";
  const mimeType = mime.lookup(ext) || "application/octet-stream";

  return {
    filepath: filePath,
    originalFileName: fileName,
    size,
    mimetype: mimeType,
  };
}

/**
 * Upload a file to Strapi media library
 */
async function uploadFile(strapi: Core.Strapi, file: ReturnType<typeof getFileData>, name: string) {
  if (!file) return null;

  return strapi
    .plugin("upload")
    .service("upload")
    .upload({
      files: file,
      data: {
        fileInfo: {
          alternativeText: `An image uploaded to Strapi called ${name}`,
          caption: name,
          name,
        },
      },
    });
}

/**
 * Check if file exists in Strapi, upload if not
 */
async function checkFileExistsBeforeUpload(strapi: Core.Strapi, fileName: string | null): Promise<unknown | null> {
  if (!fileName) return null;

  // Check if the file already exists in Strapi
  const fileNameNoExtension = fileName.replace(/\.[^/.]+$/, "");
  const existingFile = await strapi.query("plugin::upload.file").findOne({
    where: { name: fileNameNoExtension },
  });

  if (existingFile) {
    return existingFile;
  }

  // File doesn't exist, upload it
  const fileData = getFileData(fileName);
  if (!fileData) return null;

  const [uploadedFile] = await uploadFile(strapi, fileData, fileNameNoExtension);
  return uploadedFile;
}

/**
 * Create an entry in Strapi
 */
async function createEntry(strapi: Core.Strapi, { model, entry }: { model: string; entry: Record<string, unknown> }) {
  try {
    console.log(`Creating ${model}:`, JSON.stringify(entry, null, 2).substring(0, 200));
    // Use type assertion for dynamic content type names
    const contentType = `api::${model}.${model}` as Parameters<typeof strapi.documents>[0];
    const result = await strapi.documents(contentType).create({
      data: entry,
      status: "published",
    });
    console.log(`Created ${model} with id:`, result?.documentId);
    return result;
  } catch (error) {
    console.error(`Error creating ${model}:`, error);
  }
}

/**
 * Import tags
 */
async function importTags(strapi: Core.Strapi) {
  console.log(`Importing ${tags.length} tags...`);
  for (const tag of tags) {
    await createEntry(strapi, {
      model: "tag",
      entry: {
        name: tag.name,
        slug: tag.slug,
      },
    });
  }
}

/**
 * Import authors
 */
async function importAuthors(strapi: Core.Strapi) {
  console.log(`Importing ${authors.length} authors...`);
  for (const author of authors) {
    let avatar = null;
    if (author.avatar) {
      avatar = await checkFileExistsBeforeUpload(strapi, author.avatar);
    }

    await createEntry(strapi, {
      model: "author",
      entry: {
        name: author.name,
        bio_fr: author.bio_fr,
        bio_en: author.bio_en,
        avatar,
      },
    });
  }
}

/**
 * Import blog posts
 */
async function importBlogPosts(strapi: Core.Strapi) {
  console.log(`Importing ${blogPosts.length} blog posts...`);

  // Get all tags and author to map relations
  const allTags = await strapi.documents("api::tag.tag").findMany({});
  const allAuthors = await strapi.documents("api::author.author").findMany({});

  console.log(`Found ${allTags.length} tags and ${allAuthors.length} authors for relations`);

  for (const post of blogPosts) {
    let coverImage = null;
    if (post.coverImage) {
      coverImage = await checkFileExistsBeforeUpload(strapi, post.coverImage);
    }

    // Map author relation - use first author if available
    const authorDoc = allAuthors.length > 0 ? allAuthors[0] : null;

    // Map tag relations based on indices in seed data
    const tagDocs = post.tags.map((t: { id: number }) => allTags[t.id - 1]).filter(Boolean);

    await createEntry(strapi, {
      model: "blog-post",
      entry: {
        title_fr: post.title_fr,
        title_en: post.title_en,
        slug: post.slug,
        excerpt_fr: post.excerpt_fr,
        excerpt_en: post.excerpt_en,
        content_fr: post.content_fr,
        content_en: post.content_en,
        coverImage,
        youtubeVideoId: post.youtubeVideoId,
        author: authorDoc ? { documentId: authorDoc.documentId } : null,
        tags: tagDocs.map((t: { documentId: string }) => ({ documentId: t.documentId })),
      },
    });
  }
}

/**
 * Main import function - imports all seed data
 */
async function importSeedData(strapi: Core.Strapi) {
  // Allow read of application content types
  await setPublicPermissions(strapi, {
    "blog-post": ["find", "findOne"],
    tag: ["find", "findOne"],
    author: ["find", "findOne"],
  });

  // Create all entries in dependency order
  await importTags(strapi);
  await importAuthors(strapi);
  await importBlogPosts(strapi);
}
