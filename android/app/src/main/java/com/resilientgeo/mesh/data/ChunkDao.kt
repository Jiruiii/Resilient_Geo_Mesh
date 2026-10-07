package com.resilientgeo.mesh.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface ChunkDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertSync(entity: ChunkEntity)

    /**
     * Every chunk held for one dataset, ordered so a peer summary built
     * from it is byte-stable across calls — two nodes comparing HELLOs
     * should not see spurious differences caused by row ordering.
     */
    @Query(
        "SELECT * FROM chunks WHERE datasetId = :datasetId AND namespace = :namespace " +
            "ORDER BY chunkId",
    )
    fun forDatasetSync(datasetId: String, namespace: String): List<ChunkEntity>

    @Query("SELECT * FROM chunks ORDER BY datasetId, namespace, chunkId")
    fun allSync(): List<ChunkEntity>

    @Query("SELECT * FROM chunks WHERE namespace LIKE 'official.%' ORDER BY datasetId, namespace, chunkId")
    fun officialSync(): List<ChunkEntity>

    @Query("SELECT COUNT(*) FROM chunks")
    fun countSync(): Int

    @Query("DELETE FROM chunks WHERE datasetId = :datasetId AND namespace = :namespace AND chunkId = :chunkId")
    fun deleteSync(datasetId: String, namespace: String, chunkId: String)
}
